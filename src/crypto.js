const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

const deriveKey = (rawKey) =>
  crypto.createHash("sha256").update(rawKey, "utf8").digest();

const loadKey = ({ keyFile, appSecretKey }) => {
  if (appSecretKey) {
    return deriveKey(appSecretKey);
  }

  fs.mkdirSync(path.dirname(keyFile), { recursive: true });

  if (fs.existsSync(keyFile)) {
    const stored = fs.readFileSync(keyFile, "utf8").trim();
    return Buffer.from(stored, "base64");
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
  return key;
};

const createSecretBox = (options) => {
  const key = loadKey(options);

  const encrypt = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
  };

  const decrypt = (payload) => {
    if (!payload) {
      return null;
    }

    const parts = `${payload}`.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error("Unsupported secret payload");
    }

    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  };

  return { encrypt, decrypt };
};

module.exports = { createSecretBox };
