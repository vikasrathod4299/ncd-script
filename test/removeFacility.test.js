const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorage } = require("../src/storage");
const { removeFacility } = require("../src/removeFacility");

const username = "124-cho176533";

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-remove-"));
  const storage = createStorage({ dbPath: path.join(dir, "app.db") });
  const config = {
    importDir: path.join(dir, "import"),
    jobsDir: path.join(dir, "jobs"),
    outputDir: path.join(dir, "upload"),
  };
  fs.mkdirSync(config.importDir, { recursive: true });
  fs.mkdirSync(config.jobsDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
  return {
    dir,
    storage,
    config,
    logger: { info() {}, warn() {}, error() {} },
  };
};

const addFacility = (storage) => {
  storage.upsertFacility({
    id: username,
    username,
    displayName: "User",
    authStatus: "ok",
  });
};

const addJob = (storage, config, { id = "job-1", status = "completed" } = {}) => {
  const inputDir = path.join(config.importDir, id);
  const inputPath = path.join(inputDir, `${username}.xlsx`);
  const outputDir = path.join(config.outputDir, username, id);
  const workDir = path.join(config.jobsDir, id);
  for (const dir of [inputDir, outputDir, workDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(inputPath, "sheet");
  fs.writeFileSync(path.join(workDir, "prepared.json"), "{}");
  fs.writeFileSync(path.join(outputDir, `${username}.report.xlsx`), "report");

  storage.createJob({
    id,
    facilityId: username,
    inputPath,
    outputDir,
    params: {},
  });
  storage.upsertJobRow(id, 0, "individual-1", "success", {
    "Individual ID": "individual-1",
    500: "success",
    600: "success",
  });
  storage.addEvent({ jobId: id, facilityId: username, message: "queued" });
  if (status !== "queued") {
    storage.setJobStatus(id, status);
  }
  return { inputDir, inputPath, outputDir, workDir };
};

test("account-only removal keeps jobs and files", async () => {
  const { dir, storage, config, logger } = setup();
  try {
    addFacility(storage);
    const files = addJob(storage, config);

    const result = await removeFacility({
      storage,
      config,
      facilityId: username,
      mode: "account",
      logger,
    });

    assert.equal(result.mode, "account");
    assert.equal(storage.getFacility(username), null);
    assert.equal(storage.getJob("job-1").facilityId, username);
    assert.equal(storage.getFacilityJobStats(username).rows, 1);
    assert.equal(fs.existsSync(files.inputDir), true);
    assert.equal(fs.existsSync(files.outputDir), true);
    assert.equal(fs.existsSync(files.workDir), true);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("full purge removes jobs, results, events, and managed files", async () => {
  const { dir, storage, config, logger } = setup();
  try {
    addFacility(storage);
    const files = addJob(storage, config);

    const result = await removeFacility({
      storage,
      config,
      facilityId: username,
      mode: "all",
      logger,
    });

    assert.equal(result.mode, "all");
    assert.equal(result.jobsDeleted, 1);
    assert.equal(storage.getFacility(username), null);
    assert.equal(storage.getJob("job-1"), null);
    assert.equal(storage.getFacilityJobStats(username).total, 0);
    assert.equal(storage.getFacilityJobStats(username).rows, 0);
    assert.equal(fs.existsSync(files.inputDir), false);
    assert.equal(fs.existsSync(files.outputDir), false);
    assert.equal(fs.existsSync(files.workDir), false);
    assert.equal(fs.existsSync(path.join(config.outputDir, username)), false);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to remove while a job is queued or running", async () => {
  const { dir, storage, config, logger } = setup();
  try {
    addFacility(storage);
    addJob(storage, config, { status: "running" });

    await assert.rejects(
      removeFacility({
        storage,
        config,
        facilityId: username,
        mode: "account",
        logger,
      }),
      (error) => error.code === "ACTIVE_JOBS",
    );
    assert.equal(storage.getFacility(username)?.id, username);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
