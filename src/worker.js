const fs = require("fs").promises;
const path = require("path");
const { runJob } = require("./runner.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isSuccessRow = (row) =>
  row?.["500"] === "success" && row?.["600"] === "success";

const createWorker = ({
  storage,
  tokenManager,
  config,
  logger,
  notifier,
  runJobFn = runJob,
}) => {
  let running = false;
  let loopPromise = null;
  let currentJobPromise = null;
  const lastProgressAt = new Map();

  const notify = async (task, ...args) => {
    if (!notifier) {
      return;
    }
    try {
      await task(...args);
    } catch (error) {
      logger.error(`Notification failed: ${error.message}`);
    }
  };

  const processJob = async (job) => {
    const facility = storage.getFacility(job.facilityId);
    if (!facility) {
      storage.setJobStatus(job.id, "failed", { error: "Facility not found" });
      return;
    }

    const params = job.params || {};
    const dryRun = params.dryRun ?? config.dryRun;

    if (facility.authStatus !== "ok" && !dryRun) {
      storage.setJobStatus(job.id, "auth_required", {
        error: `Facility ${facility.id} needs login`,
      });
      await notify(notifier?.onAuthRequired, job, "Facility needs login");
      return;
    }

    const jobLogger = logger.child(`job:${job.id}`);
    const jobDir = path.join(config.jobsDir, job.id);
    const preparedPath = path.join(jobDir, "prepared.json");

    const jobConfig = {
      id: job.id,
      inputFilePath: job.inputPath,
      outputDir: job.outputDir,
      preparedPath,
      userName: facility.username,
      displayName: facility.displayName,
      concurrency: params.concurrency || config.defaultConcurrency,
      entriesPerDate: params.entriesPerDate || 0,
      successEntries: params.successEntries || 0,
      overwriteRandomData: params.overwriteRandomData ?? true,
      writePreparedSheet: params.writePreparedSheet ?? true,
      baseUrl: config.portalBaseUrl,
      basicAuth: config.portalBasicAuth,
      tokenStore: tokenManager.makeTokenStore(facility.id),
    };

    const previousRows = storage.getJobRows(job.id);
    const initialResults = previousRows.map((row) => ({
      index: row.rowIndex,
      row: row.result,
    }));
    const previousSuccessCount = previousRows.filter((row) =>
      isSuccessRow(row.result),
    ).length;

    await notify(notifier?.onJobStarted, job, facility);

    let result;
    try {
      if (!dryRun) {
        await tokenManager.ensureFresh(facility.id, {
          force: config.forceRefreshOnJobStart,
        });
      }
      result = await runJobFn(jobConfig, {
        logger,
        dryRun,
        initialResults,
        initialSuccessCount: previousSuccessCount,
        onTotal: (total) => storage.setJobTotal(job.id, total),
        onPrepared: (preparedSheetPath) => {
          storage.setJobResultPaths(job.id, { preparedPath: preparedSheetPath });
        },
        onRowResult: ({ index, row }) => {
          storage.upsertJobRow(
            job.id,
            index,
            row["Individual ID"],
            row["CBAC"] || "processed",
            row,
          );
        },
        onProgress: async (progress) => {
          storage.updateJobProgress(job.id, {
            doneRows: progress.done,
            successRows: progress.success,
          });
          const timestamp = Date.now();
          const last = lastProgressAt.get(job.id) || 0;
          if (timestamp - last >= config.progressIntervalMs || progress.done === progress.total) {
            lastProgressAt.set(job.id, timestamp);
            await notify(notifier?.onProgress, job, progress);
          }
        },
        onReport: (reportPath) => {
          storage.setJobResultPaths(job.id, { reportPath });
        },
      });

      storage.updateJobProgress(job.id, {
        doneRows: result.results.length,
        successRows: result.successCount,
      });
      storage.setJobStatus(job.id, "completed");
      try {
        await fs.rm(jobDir, { recursive: true, force: true });
      } catch (error) {
        jobLogger.warn(`Could not remove prepared cache: ${error.message}`);
      }

      const completedJob = storage.getJob(job.id);
      if (completedJob?.preparedPath) {
        try {
          await fs.rm(completedJob.preparedPath, { force: true });
          storage.clearJobPreparedPath(job.id);
        } catch (error) {
          jobLogger.warn(`Could not remove prepared sheet: ${error.message}`);
        }
      }

      const finishedJob = storage.getJob(job.id);
      await notify(notifier?.onJobFinished, finishedJob, {
        reportPath: finishedJob?.reportPath,
      });
    } catch (error) {
      if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_REFRESH_FAILED") {
        storage.setJobStatus(job.id, "auth_required", { error: error.message });
        storage.setFacilityAuthStatus(facility.id, "auth_required");
        await notify(notifier?.onAuthRequired, job, error);
      } else {
        jobLogger.error(error);
        storage.setJobStatus(job.id, "failed", { error: error.message });
        await notify(notifier?.onJobFailed, job, error);
      }
    } finally {
      lastProgressAt.delete(job.id);
    }
  };

  const loop = async () => {
    while (running) {
      const job = storage.claimNextJob();
      if (!job) {
        await sleep(config.workerPollIntervalMs);
        continue;
      }
      logger.info(`Claimed job ${job.id} for ${job.facilityId}`);
      currentJobPromise = processJob(job);
      await currentJobPromise;
      currentJobPromise = null;
    }
  };

  const start = () => {
    if (running) {
      return;
    }
    running = true;
    const stale = storage.requeueStaleJobs();
    if (stale.length > 0) {
      logger.warn(`Requeued ${stale.length} stale running job(s)`);
    }
    loopPromise = loop().catch((error) => {
      logger.error(error);
      running = false;
    });
  };

  const stop = async () => {
    running = false;
    if (currentJobPromise) {
      await currentJobPromise.catch(() => {});
    }
    await loopPromise?.catch(() => {});
    loopPromise = null;
  };

  return { start, stop, processJob };
};

module.exports = { createWorker };
