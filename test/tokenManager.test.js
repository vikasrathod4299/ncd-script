const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorage } = require("../src/storage");
const { createSecretBox } = require("../src/crypto");
const { createTokenManager } = require("../src/tokenManager");
const { createApiClient } = require("../util");

const baseConfig = {
  portalBaseUrl: "https://portal.test",
  portalBasicAuth: "basic",
  tokenRefreshSkewMs: 60 * 1000,
  tokenRefreshIntervalMs: 60 * 1000,
  maxCaptchaAttempts: 1,
  loginPasswordEncoding: "double",
};

const withFixture = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-token-"));
  const storage = createStorage({ dbPath: path.join(dir, "app.db") });
  const secretBox = createSecretBox({
    keyFile: path.join(dir, "secret.key"),
    appSecretKey: "",
  });
  const authEvents = [];
  const tokenManager = createTokenManager({
    storage,
    secretBox,
    config: baseConfig,
    logger: { info() {}, warn() {}, error() {} },
    onAuthRequired: (event) => authEvents.push(event),
  });
  const addFacility = (secret) => {
    storage.upsertFacility({
      id: "f1",
      username: "user",
      displayName: "User",
      authStatus: "ok",
    });
    storage.setFacilitySecret("f1", secretBox.encrypt(secret));
  };
  try {
    await fn({ storage, tokenManager, addFacility, authEvents });
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("refreshes through the shared token store and persists rotated tokens", async () => {
  await withFixture(async ({ storage, tokenManager, addFacility }) => {
    addFacility({
      access_token: "old-access",
      refresh_token: "old-refresh",
      access_token_exp: Date.now() + 60 * 60 * 1000,
    });

    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url: `${url}`, body: `${options.body}` });
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const store = tokenManager.makeTokenStore("f1");
      const result = await store.refresh();
      assert.equal(result.access_token, "new-access");
      assert.equal(tokenManager.getSecret("f1").refresh_token, "new-refresh");
      assert.equal(storage.getFacility("f1").authStatus, "ok");
      assert.match(calls[0].url, /\/portal\/cphm\/oauth\/token$/);
      assert.match(calls[0].body, /refresh_token=old-refresh/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("marks the facility auth_required when the refresh token is rejected", async () => {
  await withFixture(async ({ storage, tokenManager, addFacility, authEvents }) => {
    addFacility({
      access_token: "old-access",
      refresh_token: "revoked-refresh",
      access_token_exp: Date.now() + 60 * 60 * 1000,
    });

    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response("invalid refresh token", { status: 401 });

    try {
      const store = tokenManager.makeTokenStore("f1");
      await assert.rejects(store.refresh(), (error) => {
        assert.equal(error.code, "AUTH_REFRESH_FAILED");
        return true;
      });
      assert.equal(storage.getFacility("f1").authStatus, "auth_required");
      assert.equal(authEvents.length, 1);
      assert.equal(authEvents[0].facilityId, "f1");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("API client refreshes through the token manager on 401", async () => {
  let current = { access_token: "access-1", refresh_token: "refresh-1" };
  let refreshes = 0;
  const tokenStore = {
    get: async () => ({ ...current }),
    set: async (tokens) => {
      current = { ...current, ...tokens };
    },
    refresh: async () => {
      refreshes += 1;
      current = { access_token: "access-2", refresh_token: "refresh-2" };
      return { ...current };
    },
  };

  const authHeaders = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    authHeaders.push(options.headers.Authorization);
    if (authHeaders.length === 1) {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = await createApiClient({
      tokenStore,
      baseUrl: "https://portal.test",
    });
    const data = await client.getScreeningDetails("id-1");
    assert.deepEqual(data, { ok: true });
    assert.equal(refreshes, 1);
    assert.deepEqual(authHeaders, ["Bearer access-1", "Bearer access-2"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("API client reuses tokens already rotated by the keeper", async () => {
  let gets = 0;
  let refreshes = 0;
  const tokenStore = {
    get: async () => {
      gets += 1;
      return gets === 1
        ? { access_token: "access-1", refresh_token: "refresh-1" }
        : { access_token: "access-2", refresh_token: "refresh-2" };
    },
    set: async () => {},
    refresh: async () => {
      refreshes += 1;
      return { access_token: "access-3", refresh_token: "refresh-3" };
    },
  };

  const authHeaders = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    authHeaders.push(options.headers.Authorization);
    if (authHeaders.length === 1) {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = await createApiClient({
      tokenStore,
      baseUrl: "https://portal.test",
    });
    const data = await client.getScreeningDetails("id-1");
    assert.deepEqual(data, { ok: true });
    assert.equal(refreshes, 0);
    assert.deepEqual(authHeaders, ["Bearer access-1", "Bearer access-2"]);
  } finally {
    global.fetch = originalFetch;
  }
});
