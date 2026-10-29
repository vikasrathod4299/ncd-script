require("dotenv").config();
const path = require("path");

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(`${value}`, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const splitIds = (value) =>
  `${value || ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const dataDir = path.resolve(process.env.DATA_DIR || "./data");

const config = {
  dataDir,
  dbPath: path.resolve(process.env.DB_PATH || path.join(dataDir, "app.db")),
  importDir: path.resolve(process.env.NCD_IMPORT_DIR || path.join(dataDir, "import")),
  outputDir: path.resolve(process.env.NCD_OUTPUT_DIR || path.join(dataDir, "upload")),
  jobsDir: path.resolve(process.env.JOBS_DIR || path.join(dataDir, "jobs")),
  keyFile: path.resolve(process.env.APP_SECRET_KEY_FILE || path.join(dataDir, "secret.key")),
  appSecretKey: process.env.APP_SECRET_KEY || "",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  adminIds: splitIds(process.env.ADMIN_TELEGRAM_IDS),
  allowedUserIds: splitIds(process.env.ALLOWED_TELEGRAM_IDS),
  portalBaseUrl: process.env.NCD_BASE_URL || "https://ncd.mohfw.gov.in",
  portalBasicAuth:
    process.env.NCD_BASIC_AUTH || "TkNEQnJvd3NlcjpTZWN1cmVOQ0Q=",
  defaultConcurrency: toInt(process.env.NCD_CONCURRENCY, 3),
  tokenRefreshIntervalMs: toInt(process.env.TOKEN_REFRESH_INTERVAL_MS, 30 * 60 * 1000),
  tokenRefreshSkewMs: toInt(process.env.TOKEN_REFRESH_SKEW_MS, 20 * 60 * 1000),
  forceRefreshOnJobStart: `${process.env.NCD_FORCE_REFRESH_ON_JOB_START || ""}` === "1",
  workerPollIntervalMs: toInt(process.env.WORKER_POLL_INTERVAL_MS, 2000),
  progressIntervalMs: toInt(process.env.PROGRESS_INTERVAL_MS, 15000),
  maxCaptchaAttempts: toInt(process.env.MAX_CAPTCHA_ATTEMPTS, 3),
  captchaReplyTimeoutMs: toInt(process.env.CAPTCHA_REPLY_TIMEOUT_MS, 2 * 60 * 1000),
  maxDownloadBytes: toInt(process.env.MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024),
  dryRun: `${process.env.NCD_DRY_RUN || ""}` === "1",
  loginPasswordEncoding: process.env.NCD_LOGIN_PASSWORD_ENCODING || "double",
  logLevel: process.env.LOG_LEVEL || "info",
};

module.exports = config;
