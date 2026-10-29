const config = require("./config");

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const minimum = levels[config.logLevel] || levels.info;

const secretPatterns = [
  /("?(?:access_token|refresh_token|password|secret|authorization)"?\s*[:=]\s*)("?)[^",\s}]+("?)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

const redact = (value) => {
  if (typeof value === "string") {
    return secretPatterns.reduce(
      (text, pattern) => text.replace(pattern, "$1$2[REDACTED]$3"),
      value,
    );
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const write = (level, scope, args) => {
  if ((levels[level] || levels.info) < minimum) {
    return;
  }
  const timestamp = new Date().toISOString();
  const prefix = scope ? `[${timestamp}] ${level.toUpperCase()} (${scope})` : `[${timestamp}] ${level.toUpperCase()}`;
  const line = args.map(redact).join(" ");
  const output = `${prefix} ${line}`;
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
};

const createLogger = (scope = "") => ({
  debug: (...args) => write("debug", scope, args),
  info: (...args) => write("info", scope, args),
  warn: (...args) => write("warn", scope, args),
  error: (...args) => write("error", scope, args),
  child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
});

module.exports = createLogger();
