const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJobMessage } = require("../src/parseJobMessage");

test("parses username and numeric params", () => {
  const parsed = parseJobMessage(
    "/run username=124-cho176533 entriesPerDate=200 concurrency=5 successEntries=10",
  );
  assert.equal(parsed.facilityId, "124-cho176533");
  assert.deepEqual(parsed.params, {
    entriesPerDate: 200,
    concurrency: 5,
    successEntries: 10,
  });
});

test("accepts facility alias and bare username with booleans", () => {
  const withAlias = parseJobMessage(
    "/run facility=124-cho176533 entriesPerDate=25",
  );
  assert.equal(withAlias.facilityId, "124-cho176533");

  const parsed = parseJobMessage("/run 124-cho176533 dryRun=1 writePreparedSheet=false");
  assert.equal(parsed.facilityId, "124-cho176533");
  assert.equal(parsed.params.dryRun, true);
  assert.equal(parsed.params.writePreparedSheet, false);
});

test("rejects invalid concurrency", () => {
  assert.throws(
    () => parseJobMessage("/run username=124-cho176533 concurrency=99"),
    /Invalid concurrency/,
  );
});

test("returns null for non-run captions", () => {
  assert.equal(parseJobMessage("hello"), null);
});
