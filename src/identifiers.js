const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const isValidIdentifier = (value) =>
  typeof value === "string" && identifierPattern.test(value);

const assertIdentifier = (value, label = "username") => {
  if (!isValidIdentifier(value)) {
    throw new Error(
      `Invalid ${label}: use 1-64 characters (letters, numbers, hyphen, underscore)`,
    );
  }
  return value;
};

module.exports = { identifierPattern, isValidIdentifier, assertIdentifier };
