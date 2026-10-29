const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorage } = require("../src/storage");
const { createWorker } = require("../src/worker");

const successRow = (index) => ({
  "Individual ID": `id-${index}`,
  CBAC: "success",
  500: "success",
  600: "success",
});

const config = {
  jobsDir: path.join(os.tmpdir(), "ncd-jobs-test"),
  defaultConcurrency: 1,
  progressIntervalMs: 0,
  dryRun: false,
  portalBaseUrl: "https://portal.test",
  portalBasicAuth: "basic",
};

test("pauses on auth failure and resumes from the last saved row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-worker-"));
  const storage = createStorage({ dbPath: path.join(dir, "app.db") });
  const authEvents = [];
  const tokenManager = {
    ensureFresh: async () => {},
    makeTokenStore: () => ({}),
  };
  const notifier = {
    onJobStarted: async () => {},
    onProgress: async () => {},
    onJobFinished: async () => {},
    onJobFailed: async () => {},
    onAuthRequired: async (job, error) => authEvents.push({ job, error }),
  };

  const calls = [];
  const preparedPath = path.join(dir, "prepared.xlsx");
  const runJobFn = async (jobConfig, options) => {
    calls.push({
      initialResults: options.initialResults,
      initialSuccessCount: options.initialSuccessCount,
    });

    if (calls.length === 1) {
      options.onTotal(2);
      options.onRowResult({ index: 0, row: successRow(0) });
      options.onProgress({ done: 1, total: 2, success: 1, row: successRow(0) });
      const error = new Error("refresh token rejected");
      error.code = "AUTH_REFRESH_FAILED";
      throw error;
    }

    fs.writeFileSync(preparedPath, "prepared sheet");
    options.onPrepared(preparedPath);
    options.onRowResult({ index: 1, row: successRow(1) });
    options.onProgress({ done: 2, total: 2, success: 2, row: successRow(1) });
    return {
      results: [successRow(0), successRow(1)],
      successCount: 2,
      preparedRows: [successRow(0), successRow(1)],
      closed: true,
    };
  };

  const worker = createWorker({
    storage,
    tokenManager,
    config,
    logger: { info() {}, warn() {}, error() {}, child: () => ({ info() {}, error() {} }) },
    notifier,
    runJobFn,
  });

  try {
    storage.upsertFacility({
      id: "f1",
      username: "user",
      displayName: "User",
      authStatus: "ok",
    });
    storage.createJob({
      id: "job-1",
      facilityId: "f1",
      inputPath: path.join(dir, "input.xlsx"),
      outputDir: path.join(dir, "out"),
      params: { concurrency: 1, dryRun: false },
    });

    await worker.processJob(storage.getJob("job-1"));

    let job = storage.getJob("job-1");
    assert.equal(job.status, "auth_required");
    assert.equal(job.doneRows, 1);
    assert.equal(job.successRows, 1);
    assert.equal(authEvents.length, 1);
    assert.equal(storage.getJobRows("job-1").length, 1);
    assert.equal(storage.getFacility("f1").authStatus, "auth_required");

    storage.setFacilityAuthStatus("f1", "ok");
    assert.equal(storage.requeueAuthRequiredJobs("f1"), 1);
    job = storage.getJob("job-1");
    assert.equal(job.status, "queued");
    assert.equal(job.finishedAt, null);

    await worker.processJob(job);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1].initialResults.map((item) => item.index),
      [0],
    );
    assert.equal(calls[1].initialSuccessCount, 1);
    assert.equal(storage.getJobRows("job-1").length, 2);

    job = storage.getJob("job-1");
    assert.equal(job.status, "completed");
    assert.equal(job.doneRows, 2);
    assert.equal(job.successRows, 2);
    assert.equal(job.preparedPath, null);
    assert.equal(fs.existsSync(preparedPath), false);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
