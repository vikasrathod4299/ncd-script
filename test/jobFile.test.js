const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSheetFileName } = require("../src/jobFile");

test("names the imported sheet after the username", () => {
  assert.equal(
    resolveSheetFileName("124-cho176533", "random-upload.XLSX"),
    "124-cho176533.xlsx",
  );
  assert.equal(
    resolveSheetFileName("124-cho176533", "old-format.xls"),
    "124-cho176533.xls",
  );
});

test("rejects unsupported sheet extensions", () => {
  assert.throws(
    () => resolveSheetFileName("124-cho176533", "sheet.csv"),
    /Only \.xlsx or \.xls/,
  );
});
