const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const now = () => Date.now();

const parseJson = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const createStorage = ({ dbPath }) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS facilities (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT,
      secret TEXT,
      auth_status TEXT NOT NULL DEFAULT 'unknown',
      owner_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      facility_id TEXT NOT NULL,
      owner_id TEXT,
      chat_id TEXT,
      message_id INTEGER,
      input_path TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      params TEXT NOT NULL,
      total_rows INTEGER NOT NULL DEFAULT 0,
      done_rows INTEGER NOT NULL DEFAULT 0,
      success_rows INTEGER NOT NULL DEFAULT 0,
      report_path TEXT,
      prepared_path TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_rows (
      job_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      individual_id TEXT,
      status TEXT NOT NULL,
      result TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, row_index),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      facility_id TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_facility ON jobs(facility_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id);
  `);

  const ensureColumn = (table, column, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  ensureColumn("facilities", "owner_id", "TEXT");
  ensureColumn("jobs", "owner_id", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facilities_owner ON facilities(owner_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id, created_at);
  `);

  const upsertFacility = (facility) => {
    const timestamp = now();
    db.prepare(
      `INSERT INTO facilities (id, username, display_name, secret, auth_status, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         display_name = COALESCE(excluded.display_name, facilities.display_name),
         secret = COALESCE(excluded.secret, facilities.secret),
         auth_status = COALESCE(excluded.auth_status, facilities.auth_status),
         owner_id = COALESCE(facilities.owner_id, excluded.owner_id),
         updated_at = excluded.updated_at`,
    ).run(
      facility.id,
      facility.username,
      facility.displayName || null,
      facility.secret || null,
      facility.authStatus || "unknown",
      facility.ownerId || null,
      timestamp,
      timestamp,
    );
    return getFacility(facility.id);
  };

  const getFacility = (id) => {
    const row = db.prepare("SELECT * FROM facilities WHERE id = ?").get(id);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      secret: row.secret,
      authStatus: row.auth_status,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const listFacilities = ({ ownerId } = {}) => {
    const rows = ownerId
      ? db
          .prepare("SELECT * FROM facilities WHERE owner_id = ? ORDER BY id")
          .all(ownerId)
      : db.prepare("SELECT * FROM facilities ORDER BY id").all();
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      authStatus: row.auth_status,
      ownerId: row.owner_id,
      updatedAt: row.updated_at,
    }));
  };

  const setFacilitySecret = (id, secret, displayName) => {
    db.prepare(
      `UPDATE facilities
       SET secret = ?, display_name = COALESCE(?, display_name), updated_at = ?
       WHERE id = ?`,
    ).run(secret, displayName || null, now(), id);
  };

  const setFacilityAuthStatus = (id, status) => {
    db.prepare("UPDATE facilities SET auth_status = ?, updated_at = ? WHERE id = ?").run(
      status,
      now(),
      id,
    );
  };

  const createJob = (job) => {
    const id =
      job.id ||
      `job-${now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO jobs
        (id, facility_id, owner_id, chat_id, message_id, input_path, output_dir, status, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      job.facilityId,
      job.ownerId || null,
      job.chatId || null,
      job.messageId || null,
      job.inputPath,
      job.outputDir,
      "queued",
      JSON.stringify(job.params || {}),
      timestamp,
      timestamp,
    );
    return getJob(id);
  };

  const getJob = (id) => {
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? mapJob(row) : null;
  };

  const mapJob = (row) => ({
    id: row.id,
    facilityId: row.facility_id,
    ownerId: row.owner_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    inputPath: row.input_path,
    outputDir: row.output_dir,
    status: row.status,
    params: parseJson(row.params, {}),
    totalRows: row.total_rows,
    doneRows: row.done_rows,
    successRows: row.success_rows,
    reportPath: row.report_path,
    preparedPath: row.prepared_path,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  });

  const listJobs = ({ limit = 10, facilityId, ownerId, ownerIds } = {}) => {
    const where = [];
    const values = [];
    if (facilityId) {
      where.push("facility_id = ?");
      values.push(facilityId);
    }
    if (ownerId) {
      where.push("owner_id = ?");
      values.push(ownerId);
    }
    if (ownerIds?.length) {
      where.push(`owner_id IN (${ownerIds.map(() => "?").join(", ")})`);
      values.push(...ownerIds);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit);
    return rows.map(mapJob);
  };

  const claimNextJob = () => {
    const row = db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get();
    if (!row) {
      return null;
    }
    const timestamp = now();
    const result = db
      .prepare(
        "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(timestamp, timestamp, row.id);
    if (result.changes !== 1) {
      return null;
    }
    return getJob(row.id);
  };

  const setJobStatus = (id, status, { error = null } = {}) => {
    const timestamp = now();
    const finished = ["completed", "failed", "cancelled", "auth_required"].includes(status)
      ? timestamp
      : null;
    db.prepare(
      `UPDATE jobs
       SET status = ?, error = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    ).run(status, error, timestamp, finished, id);
  };

  const setJobTotal = (id, totalRows) => {
    db.prepare("UPDATE jobs SET total_rows = ?, updated_at = ? WHERE id = ?").run(
      totalRows,
      now(),
      id,
    );
  };

  const updateJobProgress = (id, { doneRows = null, successRows = null } = {}) => {
    db.prepare(
      `UPDATE jobs
       SET done_rows = COALESCE(?, done_rows),
           success_rows = COALESCE(?, success_rows),
           updated_at = ?
       WHERE id = ?`,
    ).run(doneRows, successRows, now(), id);
  };

  const setJobResultPaths = (id, { reportPath, preparedPath }) => {
    db.prepare(
      `UPDATE jobs
       SET report_path = COALESCE(?, report_path),
           prepared_path = COALESCE(?, prepared_path),
           updated_at = ?
       WHERE id = ?`,
    ).run(reportPath || null, preparedPath || null, now(), id);
  };

  const clearJobPreparedPath = (id) => {
    db.prepare(
      "UPDATE jobs SET prepared_path = NULL, updated_at = ? WHERE id = ?",
    ).run(now(), id);
  };

  const upsertJobRow = (jobId, rowIndex, individualId, status, result) => {
    db.prepare(
      `INSERT INTO job_rows (job_id, row_index, individual_id, status, result, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, row_index) DO UPDATE SET
         status = excluded.status,
         result = excluded.result,
         updated_at = excluded.updated_at`,
    ).run(jobId, rowIndex, individualId || null, status, JSON.stringify(result), now());
  };

  const getJobRows = (jobId) =>
    db
      .prepare("SELECT * FROM job_rows WHERE job_id = ? ORDER BY row_index")
      .all(jobId)
      .map((row) => ({
        rowIndex: row.row_index,
        individualId: row.individual_id,
        status: row.status,
        result: parseJson(row.result, {}),
      }));

  const addEvent = ({ jobId = null, facilityId = null, level = "info", message }) => {
    db.prepare(
      "INSERT INTO events (job_id, facility_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(jobId, facilityId, level, message, now());
  };

  const requeueAuthRequiredJobs = (facilityId) => {
    const result = db
      .prepare(
        "UPDATE jobs SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ? WHERE facility_id = ? AND status = 'auth_required'",
      )
      .run(now(), facilityId);
    return result.changes;
  };

  const getFacilityJobs = (facilityId) =>
    db
      .prepare("SELECT * FROM jobs WHERE facility_id = ? ORDER BY created_at")
      .all(facilityId)
      .map(mapJob);

  const getFacilityJobStats = (facilityId) => {
    const stats = {
      total: 0,
      queued: 0,
      running: 0,
      auth_required: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      rows: 0,
      events: 0,
    };
    const rows = db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs WHERE facility_id = ? GROUP BY status")
      .all(facilityId);
    for (const row of rows) {
      stats.total += row.count;
      stats[row.status] = (stats[row.status] || 0) + row.count;
    }
    stats.rows = db
      .prepare(
        "SELECT COUNT(*) AS count FROM job_rows WHERE job_id IN (SELECT id FROM jobs WHERE facility_id = ?)",
      )
      .get(facilityId).count;
    stats.events = db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE facility_id = ? OR job_id IN (SELECT id FROM jobs WHERE facility_id = ?)",
      )
      .get(facilityId, facilityId).count;
    return stats;
  };

  const claimUnownedData = (ownerId) => {
    if (!ownerId) {
      return { facilities: 0, jobs: 0 };
    }
    const timestamp = now();
    const facilities = db
      .prepare(
        "UPDATE facilities SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL",
      )
      .run(ownerId, timestamp).changes;
    const jobs = db
      .prepare(
        "UPDATE jobs SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL",
      )
      .run(ownerId, timestamp).changes;
    return { facilities, jobs };
  };

  const deleteFacility = (facilityId) =>
    db.prepare("DELETE FROM facilities WHERE id = ?").run(facilityId).changes;

  const deleteFacilityData = (facilityId) => {
    const jobs = getFacilityJobs(facilityId);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "DELETE FROM events WHERE facility_id = ? OR job_id IN (SELECT id FROM jobs WHERE facility_id = ?)",
      ).run(facilityId, facilityId);
      db.prepare(
        "DELETE FROM job_rows WHERE job_id IN (SELECT id FROM jobs WHERE facility_id = ?)",
      ).run(facilityId);
      db.prepare("DELETE FROM jobs WHERE facility_id = ?").run(facilityId);
      db.prepare("DELETE FROM facilities WHERE id = ?").run(facilityId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { jobs };
  };

  const requeueStaleJobs = () => {
    const timestamp = now();
    const rows = db.prepare("SELECT id FROM jobs WHERE status = 'running'").all();
    db.prepare(
      "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
    ).run(timestamp);
    return rows.map((row) => row.id);
  };

  const close = () => db.close();

  return {
    upsertFacility,
    getFacility,
    listFacilities,
    setFacilitySecret,
    setFacilityAuthStatus,
    createJob,
    getJob,
    listJobs,
    claimNextJob,
    setJobStatus,
    setJobTotal,
    updateJobProgress,
    setJobResultPaths,
    clearJobPreparedPath,
    upsertJobRow,
    getJobRows,
    addEvent,
    requeueAuthRequiredJobs,
    requeueStaleJobs,
    getFacilityJobs,
    getFacilityJobStats,
    claimUnownedData,
    deleteFacility,
    deleteFacilityData,
    close,
  };
};

module.exports = { createStorage };
