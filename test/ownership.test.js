const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorage } = require("../src/storage");

test("scopes accounts and jobs by owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncd-owner-"));
  const storage = createStorage({ dbPath: path.join(dir, "app.db") });
  try {
    storage.upsertFacility({
      id: "user-a",
      username: "user-a",
      displayName: "User A",
      authStatus: "ok",
      ownerId: "owner-a",
    });
    storage.upsertFacility({
      id: "user-b",
      username: "user-b",
      displayName: "User B",
      authStatus: "ok",
      ownerId: "owner-b",
    });

    storage.createJob({
      id: "job-a",
      facilityId: "user-a",
      ownerId: "owner-a",
      inputPath: path.join(dir, "a.xlsx"),
      outputDir: path.join(dir, "a"),
      params: {},
    });
    storage.createJob({
      id: "job-b",
      facilityId: "user-b",
      ownerId: "owner-b",
      inputPath: path.join(dir, "b.xlsx"),
      outputDir: path.join(dir, "b"),
      params: {},
    });

    assert.deepEqual(
      storage.listFacilities({ ownerId: "owner-a" }).map((item) => item.id),
      ["user-a"],
    );
    assert.deepEqual(
      storage.listJobs({ ownerId: "owner-a" }).map((item) => item.id),
      ["job-a"],
    );
    assert.deepEqual(
      storage.listJobs({ ownerId: "owner-b" }).map((item) => item.id),
      ["job-b"],
    );

    storage.upsertFacility({
      id: "user-a",
      username: "user-a",
      ownerId: "owner-b",
    });
    assert.equal(storage.getFacility("user-a").ownerId, "owner-a");

    storage.upsertFacility({
      id: "unowned",
      username: "unowned",
      displayName: "Unowned",
    });
    storage.createJob({
      id: "job-unowned",
      facilityId: "unowned",
      inputPath: path.join(dir, "unowned.xlsx"),
      outputDir: path.join(dir, "unowned"),
      params: {},
    });
    assert.deepEqual(storage.claimUnownedData("admin"), {
      facilities: 1,
      jobs: 1,
    });
    assert.equal(storage.getFacility("unowned").ownerId, "admin");
    assert.equal(storage.getJob("job-unowned").ownerId, "admin");
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
