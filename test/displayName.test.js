const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDisplayName,
  fetchPortalUsers,
} = require("../src/login");

test("builds the display name from the matching portal user", () => {
  const users = [
    { username: "124-cho176533", name: "KATHAN SHAH" },
    { username: "124-kanai", name: "Kamlaben Nai" },
  ];

  assert.equal(
    buildDisplayName("124-cho176533", users),
    "124-cho176533 (KATHAN SHAH)",
  );
});

test("falls back to the username when no name is available", () => {
  assert.equal(buildDisplayName("124-cho176533", []), "124-cho176533");
  assert.equal(
    buildDisplayName("124-cho176533", [{ username: "other", name: "Other" }]),
    "124-cho176533",
  );
  assert.equal(
    buildDisplayName("124-cho176533", [
      { username: "124-cho176533", name: "   " },
    ]),
    "124-cho176533",
  );
});

test("fetches users for the token location", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify([{ username: "124-cho176533", name: "KATHAN SHAH" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const users = await fetchPortalUsers({
      baseUrl: "https://portal.test",
      accessToken: "access-token",
      facilityType: "SUBCENTER",
      locationId: "12407653",
    });

    assert.deepEqual(users, [
      { username: "124-cho176533", name: "KATHAN SHAH" },
    ]);
    assert.equal(
      request.url,
      "https://portal.test/portal/cphm/readOnly/admin/adminOperations/locationType/SUBCENTER/locationId/12407653/users",
    );
    assert.equal(request.options.headers.Authorization, "Bearer access-token");
  } finally {
    global.fetch = originalFetch;
  }
});
