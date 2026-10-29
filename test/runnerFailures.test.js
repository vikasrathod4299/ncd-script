const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runJob } = require("../src/runner");
const { writeExcelFile } = require("../util");

const makeRow = (index) => ({
  "Individual ID": `id-${index}`,
  "First Name": "Test",
  "Last Name": `User ${index}`,
  Age: 40,
  Sex: "F",
});

test("stops a job when the first five entries fail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-runner-fail-"));
  const inputPath = path.join(dir, "user.xlsx");
  writeExcelFile(Array.from({ length: 6 }, (_, index) => makeRow(index)), inputPath);

  let attempts = 0;
  const logger = {
    child: () => logger,
    info() {},
    warn() {},
    error() {},
  };

  try {
    await assert.rejects(
      runJob(
        {
          id: "job-failing",
          inputFilePath: inputPath,
          outputDir: path.join(dir, "out"),
          preparedPath: path.join(dir, "jobs", "prepared.json"),
          userName: "user",
          displayName: "Test User",
          concurrency: 1,
          entriesPerDate: 0,
          successEntries: 0,
          overwriteRandomData: true,
          writePreparedSheet: false,
        },
        {
          apiClient: {
            fetchCbac: async () => {
              attempts += 1;
              throw new Error("invalid row data");
            },
          },
          logger,
          dryRun: false,
        },
      ),
      (error) =>
        error.code === "JOB_DATA_INVALID" &&
        error.message.includes("first 5 entries failed"),
    );

    assert.equal(attempts, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
