const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSecretBox } = require("../src/crypto");

test("encrypts and decrypts a secret payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-crypto-"));
  try {
    const box = createSecretBox({
      keyFile: path.join(dir, "secret.key"),
      appSecretKey: "",
    });
    const payload = { username: "u", password: "p", access_token: "token" };
    const encrypted = box.encrypt(payload);
    assert.notEqual(encrypted, JSON.stringify(payload));
    assert.deepEqual(box.decrypt(encrypted), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uses a stable key across instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-crypto-"));
  try {
    const keyFile = path.join(dir, "secret.key");
    const a = createSecretBox({ keyFile, appSecretKey: "" });
    const b = createSecretBox({ keyFile, appSecretKey: "" });
    assert.deepEqual(b.decrypt(a.encrypt({ value: 1 })), { value: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
