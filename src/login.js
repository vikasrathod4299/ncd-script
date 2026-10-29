const crypto = require("crypto");
const { DEFAULT_BASE_URL, DEFAULT_BASIC_AUTH, decodeJwt } = require("../util.js");

const PUBLIC_KEY_BASE64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArt+zXeqmeox3dBmxKK5X7mfmZJjupftpO+e7KFbJf0esUYV0aWc3Of6Sm4XVqa+jwnsINuFhorjK+k8kPmW7f2iDjTM9zKV6los0bQQS9czBiK1QRGreg9fPE/+CwM+rYKwm1HEGW6ynN17yWunYtuniZWfZLkiI7EW76ISkpfTPEUXFFwcDGgxMVALRSVwwz/C6WGXSi1jxJGBlGoMxmr7IhmPJXx9YPfLRFkIwzgY7D+pqHiprqK99PBwN+MpUH1t4XKK7HB10FpSGSU/61ZGeC+RjRMLrWQaXyow5VUsjfZ5Aldpk1JAJSo1xBh6EZrWK7I8qvUudbqcfiW0bVwIDAQAB";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY_BASE64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;

const OTP_RC = "bb856cb6-a861-44fe-af7c-0a9337e81689";

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

const encryptPassword = (username, password, encoding = "double") => {
  const usernameHash = sha256Hex(username);
  const passwordHash = sha256Hex(`${usernameHash}${password}`);
  const plaintext = `${usernameHash}:${passwordHash}:${Date.now()}`;
  const encrypted = crypto.publicEncrypt(
    { key: PUBLIC_KEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  const inner = encrypted.toString("base64");
  if (encoding === "single") {
    return inner;
  }
  return Buffer.from(inner, "utf8").toString("base64");
};

const parseCookies = (response) => {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const cookies = new Map();
  for (const header of setCookies) {
    const pair = header.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
  return cookies;
};

const cookieHeader = (cookies) =>
  Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

const readErrorPayload = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error_description: text };
  }
};

const isCaptchaError = (payload) => {
  const message = `${payload?.error_description || payload?.error || ""}`.toLowerCase();
  return message.includes("captcha") || message.includes("kaptcha");
};

const isOtpRequired = (payload) => {
  const message = `${payload?.error_description || payload?.error || ""}`.toLowerCase();
  return message.includes("otp required") || message.includes("mfa");
};

const fetchCaptcha = async ({ baseUrl, cookies }) => {
  const response = await fetch(`${baseUrl}/portal/cphc-auth/kapatcha.jpg`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch captcha: ${response.status}`);
  }
  for (const [name, value] of parseCookies(response)) {
    cookies.set(name, value);
  }
  return Buffer.from(await response.arrayBuffer());
};

const requestToken = async ({
  baseUrl,
  basicAuth,
  username,
  password,
  captcha,
  cookies,
  passwordEncoding,
}) => {
  const form = new URLSearchParams();
  form.set("grant_type", "password");
  form.set("password", encryptPassword(username, password, passwordEncoding));
  form.set("username", username);
  form.set("kaptcha", captcha);
  form.set("source_type", "0");

  return fetch(`${baseUrl}/portal/cphc-auth/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
      txnUser: username,
      Cookie: cookieHeader(cookies),
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    body: form,
  });
};

const sendOtp = async ({ baseUrl, basicAuth, username, cookies }) => {
  const response = await fetch(
    `${baseUrl}/portal/cphc-auth/mfa/getOTPForMfa?userName=${encodeURIComponent(username)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basicAuth}`,
        txnUser: username,
        Cookie: cookieHeader(cookies),
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new Error(
      `Unable to request OTP: ${payload.error_description || payload.error || response.status}`,
    );
  }
  return response.json().catch(() => ({}));
};

const verifyOtp = async ({ baseUrl, basicAuth, username, otp, cookies }) => {
  const response = await fetch(`${baseUrl}/portal/cphc-auth/mfa/verifyOTPForMfa`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
      txnUser: username,
      Cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({
      otpStr: sha256Hex(`${otp}`),
      rc: OTP_RC,
      userName: username,
    }),
  });
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new Error(
      `Unable to verify OTP: ${payload.error_description || payload.error || response.status}`,
    );
  }
  return response.json().catch(() => false);
};

const loginWithPassword = async ({
  username,
  password,
  baseUrl = DEFAULT_BASE_URL,
  basicAuth = DEFAULT_BASIC_AUTH,
  requestCaptchaText,
  requestOtp,
  maxAttempts = 3,
  passwordEncoding = "double",
  logger = console,
}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const cookies = new Map();
    const image = await fetchCaptcha({ baseUrl, cookies });
    const captcha = (await requestCaptchaText({ image, attempt })).trim();
    if (!captcha) {
      throw new Error("Captcha was not provided");
    }

    let response = await requestToken({
      baseUrl,
      basicAuth,
      username,
      password,
      captcha,
      cookies,
      passwordEncoding,
    });

    if (!response.ok) {
      let payload = await readErrorPayload(response);
      if (isOtpRequired(payload)) {
        logger.info("Portal requires MFA");
        const otpResponse = await sendOtp({
          baseUrl,
          basicAuth,
          username,
          cookies,
        });

        if (otpResponse?.flowType !== "DIRECT_LOGIN") {
          const otp = await requestOtp({ username });
          const verified = await verifyOtp({
            baseUrl,
            basicAuth,
            username,
            otp,
            cookies,
          });
          if (!verified) {
            lastError = new Error("Invalid OTP");
            continue;
          }
        }

        response = await requestToken({
          baseUrl,
          basicAuth,
          username,
          password,
          captcha,
          cookies,
          passwordEncoding,
        });
        if (!response.ok) {
          payload = await readErrorPayload(response);
        }
      }

      if (!response.ok) {
        lastError = new Error(
          `Login failed: ${payload.error_description || payload.error || response.status}`,
        );
        if (isCaptchaError(payload)) {
          logger.warn(`Captcha rejected on attempt ${attempt}, retrying`);
          continue;
        }
        throw lastError;
      }
    }

    const tokens = await response.json();
    if (!tokens.access_token) {
      lastError = new Error("Login response did not include an access token");
      continue;
    }

    return {
      ...tokens,
      username,
      profile: decodeJwt(tokens.access_token),
    };
  }

  throw lastError || new Error("Login failed");
};

const buildDisplayName = (username, users) => {
  const name = users
    ?.find((user) => user?.username === username)
    ?.name?.trim();
  return name ? `${username} (${name})` : username;
};

const fetchPortalUsers = async ({
  baseUrl = DEFAULT_BASE_URL,
  accessToken,
  facilityType,
  locationId,
}) => {
  if (!accessToken || !facilityType || !locationId) {
    throw new Error("Portal users request is missing token or location details");
  }

  const url =
    `${baseUrl}/portal/cphm/readOnly/admin/adminOperations/locationType/` +
    `${encodeURIComponent(facilityType)}/locationId/${encodeURIComponent(locationId)}/users`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      Referer: `${baseUrl}/portal/`,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Unable to fetch portal users: ${response.status} ${errorBody}`.trim(),
    );
  }

  const users = await response.json();
  if (!Array.isArray(users)) {
    throw new Error("Portal users response was not an array");
  }
  return users;
};

module.exports = {
  loginWithPassword,
  encryptPassword,
  buildDisplayName,
  fetchPortalUsers,
};
