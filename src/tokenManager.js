const {
  createApiClient,
  refreshTokens,
  getTokenExpiry,
  DEFAULT_BASE_URL,
  DEFAULT_BASIC_AUTH,
} = require("../util.js");
const {
  loginWithPassword,
  buildDisplayName,
  fetchPortalUsers,
} = require("./login.js");

const authError = (message = "Portal authentication required") => {
  const error = new Error(message);
  error.code = "AUTH_REQUIRED";
  return error;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createTokenManager = ({
  storage,
  secretBox,
  config,
  logger,
  onAuthRequired,
}) => {
  const locks = new Map();
  let keeperTimer = null;
  let keeperStartTimer = null;

  const withLock = (facilityId, task) => {
    const previous = locks.get(facilityId) || Promise.resolve();
    const run = previous.catch(() => { }).then(task);
    locks.set(facilityId, run);
    run
      .finally(() => {
        if (locks.get(facilityId) === run) {
          locks.delete(facilityId);
        }
      })
      .catch(() => { });
    return run;
  };

  const getFacilityOrThrow = (facilityId) => {
    const facility = storage.getFacility(facilityId);
    if (!facility) {
      throw new Error(`Facility not found: ${facilityId}`);
    }
    return facility;
  };

  const readSecret = (facility) => {
    if (!facility?.secret) {
      return {};
    }
    return secretBox.decrypt(facility.secret) || {};
  };

  const writeSecret = (facilityId, secret) => {
    storage.setFacilitySecret(
      facilityId,
      secretBox.encrypt(secret),
      secret.displayName,
    );
  };

  const baseUrl = config.portalBaseUrl || DEFAULT_BASE_URL;
  const basicAuth = config.portalBasicAuth || DEFAULT_BASIC_AUTH;

  const applyTokens = (facilityId, currentSecret, tokens) => {
    const secret = {
      ...currentSecret,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || currentSecret.refresh_token,
      access_token_exp: getTokenExpiry(tokens.access_token),
      refresh_token_exp: getTokenExpiry(tokens.refresh_token || currentSecret.refresh_token),
      updatedAt: Date.now(),
    };
    writeSecret(facilityId, secret);
    storage.setFacilityAuthStatus(facilityId, "ok");
    return secret;
  };

  const refreshUnlocked = async (facilityId) => {
    const facility = getFacilityOrThrow(facilityId);
    const secret = readSecret(facility);
    if (!secret.refresh_token) {
      storage.setFacilityAuthStatus(facilityId, "auth_required");
      const error = authError(`No refresh token for ${facilityId}`);
      onAuthRequired?.({ facilityId, error });
      throw error;
    }

    try {
      let tokens;
      for (let attempt = 0; ; attempt += 1) {
        try {
          tokens = await refreshTokens({
            refreshToken: secret.refresh_token,
            baseUrl,
            basicAuth,
          });
          break;
        } catch (error) {
          const transient = error.code === "TOKEN_REFRESH_TRANSIENT";
          if (!transient || attempt >= 2) {
            throw error;
          }
          await sleep(500 * 2 ** attempt);
        }
      }
      const updated = applyTokens(facilityId, secret, tokens);
      logger.info(`Refreshed token for ${facilityId}`);
      return updated;
    } catch (error) {
      if (error.code === "AUTH_REFRESH_FAILED") {
        storage.setFacilityAuthStatus(facilityId, "auth_required");
        logger.error(`Token refresh failed for ${facilityId}: ${error.message}`);
        onAuthRequired?.({ facilityId, error });
      } else {
        logger.warn(`Transient token refresh error for ${facilityId}: ${error.message}`);
      }
      throw error;
    }
  };

  const refresh = (facilityId) =>
    withLock(facilityId, () => refreshUnlocked(facilityId));

  const ensureFresh = (facilityId, { force = false } = {}) =>
    withLock(facilityId, async () => {
      const facility = getFacilityOrThrow(facilityId);
      const secret = readSecret(facility);

      if (!secret.access_token || !secret.refresh_token) {
        storage.setFacilityAuthStatus(facilityId, "auth_required");
        const error = authError(`No tokens stored for ${facilityId}`);
        onAuthRequired?.({ facilityId, error });
        throw error;
      }

      const expiresAt =
        secret.access_token_exp || getTokenExpiry(secret.access_token) || 0;
      const shouldRefresh =
        force || !expiresAt || expiresAt - Date.now() < config.tokenRefreshSkewMs;

      if (shouldRefresh) {
        return refreshUnlocked(facilityId);
      }

      return secret;
    });

  const makeTokenStore = (facilityId) => ({
    get: () =>
      withLock(facilityId, async () => {
        const facility = getFacilityOrThrow(facilityId);
        const secret = readSecret(facility);
        if (!secret.access_token || !secret.refresh_token) {
          throw authError(`No tokens stored for ${facilityId}`);
        }
        return {
          access_token: secret.access_token,
          refresh_token: secret.refresh_token,
        };
      }),
    set: (tokens) =>
      withLock(facilityId, async () => {
        const facility = getFacilityOrThrow(facilityId);
        const secret = readSecret(facility);
        applyTokens(facilityId, secret, tokens);
      }),
    refresh: () => refresh(facilityId),
  });

  const getApiClient = async (facilityId) => {
    await ensureFresh(facilityId);
    return createApiClient({
      tokenStore: makeTokenStore(facilityId),
      baseUrl,
      basicAuth,
    });
  };

  const saveCredentials = ({
    facilityId,
    username,
    password,
    ownerId,
    isAdmin = false,
  }) => {
    const id = facilityId || username;
    if (id !== username) {
      throw new Error("Facility ID must match the portal username");
    }
    const existing = storage.getFacility(id);
    if (existing) {
      if (existing.ownerId && existing.ownerId !== ownerId && !isAdmin) {
        throw new Error("This account is already registered to another user.");
      }
      if (!existing.ownerId && !isAdmin) {
        throw new Error("This account already exists. Ask an admin to update it.");
      }
    }

    const currentSecret = readSecret(existing);
    const secret = {
      ...currentSecret,
      username,
      password,
      displayName: currentSecret.displayName || existing?.displayName,
      updatedAt: Date.now(),
    };
    storage.upsertFacility({
      id,
      username,
      displayName: secret.displayName,
      authStatus: "pending_login",
      ownerId,
    });
    writeSecret(id, secret);
  };

  const resolveDisplayName = async ({
    username,
    tokens,
    fallbackDisplayName,
  }) => {
    if (!tokens.facility || !tokens.facilityType) {
      logger.warn(`Display name unavailable for ${username}: missing location details`);
      return fallbackDisplayName || username;
    }

    try {
      const users = await fetchPortalUsers({
        baseUrl,
        accessToken: tokens.access_token,
        facilityType: tokens.facilityType,
        locationId: tokens.facility,
      });
      return buildDisplayName(username, users);
    } catch (error) {
      logger.warn(`Display name unavailable for ${username}: ${error.message}`);
      return fallbackDisplayName || username;
    }
  };

  const login = (facilityId, { requestCaptchaText, requestOtp }) =>
    withLock(facilityId, async () => {
      const facility = getFacilityOrThrow(facilityId);
      const secret = readSecret(facility);
      if (!secret.password) {
        throw new Error(`No password stored for ${facilityId}. Run onboarding again.`);
      }

      const result = await loginWithPassword({
        username: facility.username,
        password: secret.password,
        baseUrl,
        basicAuth,
        requestCaptchaText,
        requestOtp,
        maxAttempts: config.maxCaptchaAttempts,
        passwordEncoding: config.loginPasswordEncoding,
        logger,
      });

      const profile = result.profile || {};
      const displayName = await resolveDisplayName({
        username: facility.username,
        tokens: result,
        fallbackDisplayName: secret.displayName,
      });
      const nextSecret = applyTokens(facilityId, secret, result);
      nextSecret.displayName = displayName;
      nextSecret.username = facility.username;
      nextSecret.profile = profile;
      nextSecret.updatedAt = Date.now();
      writeSecret(facilityId, nextSecret);
      storage.setFacilityAuthStatus(facilityId, "ok");

      return { ...result, displayName: nextSecret.displayName };
    });

  const getSecret = (facilityId) => {
    const facility = getFacilityOrThrow(facilityId);
    return readSecret(facility);
  };

  const startKeeper = () => {
    if (keeperTimer) {
      return;
    }
    const tick = async () => {
      const facilities = storage.listFacilities();
      for (const facility of facilities) {
        if (facility.authStatus === "auth_required" || facility.authStatus === "pending_login") {
          continue;
        }
        try {
          await ensureFresh(facility.id);
        } catch (error) {
          logger.warn(`Token keeper skipped ${facility.id}: ${error.message}`);
        }
      }
    };
    keeperTimer = setInterval(tick, config.tokenRefreshIntervalMs);
    keeperTimer.unref?.();
    keeperStartTimer = setTimeout(tick, 5000);
    keeperStartTimer.unref?.();
  };

  const stopKeeper = () => {
    if (keeperTimer) {
      clearInterval(keeperTimer);
      keeperTimer = null;
    }
    if (keeperStartTimer) {
      clearTimeout(keeperStartTimer);
      keeperStartTimer = null;
    }
  };

  return {
    refresh,
    ensureFresh,
    makeTokenStore,
    getApiClient,
    saveCredentials,
    login,
    getSecret,
    startKeeper,
    stopKeeper,
  };
};

module.exports = { createTokenManager };
