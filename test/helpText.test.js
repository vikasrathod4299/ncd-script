const test = require("node:test");
const assert = require("node:assert/strict");
const { helpText } = require("../src/parseJobMessage");

test("shows user commands to allowed users", () => {
  const text = helpText({ isAllowedUser: true });
  assert.match(text, /\/onboard/);
  assert.match(text, /\/run/);
  assert.doesNotMatch(text, /Admin view/);
});

test("shows user and admin commands to admins", () => {
  const text = helpText({ isAdmin: true });
  assert.match(text, /\/onboard/);
  assert.match(text, /\/run/);
  assert.match(text, /Admin view/);
  assert.match(text, /full admin and user access/);
});

test("still shows both sections when the admin is also allowed", () => {
  const text = helpText({ isAdmin: true, isAllowedUser: true });
  assert.match(text, /\/onboard/);
  assert.match(text, /\/run/);
  assert.match(text, /Admin view/);
  assert.match(text, /full admin and user access/);
});
