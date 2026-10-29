const path = require("path");

const supportedExtensions = new Set([".xlsx", ".xls"]);

const resolveSheetFileName = (username, originalName) => {
  const extension = path.extname(`${originalName || ""}`).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw new Error("Only .xlsx or .xls files are supported.");
  }
  return `${username}${extension}`;
};

module.exports = { resolveSheetFileName };
