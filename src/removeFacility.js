const fs = require("fs").promises;
const path = require("path");

const isInside = (root, target) => {
  if (!root || !target) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const removeManagedPath = async (target, roots, logger) => {
  if (!roots.some((root) => isInside(root, target))) {
    logger?.warn(`Skipping unmanaged path: ${target}`);
    return false;
  }
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger?.warn(`Could not remove ${target}: ${error.message}`);
    return false;
  }
};

const removeFacility = async ({
  storage,
  config,
  facilityId,
  mode = "account",
  logger,
}) => {
  const facility = storage.getFacility(facilityId);
  if (!facility) {
    const error = new Error(`Unknown username: ${facilityId}`);
    error.code = "FACILITY_NOT_FOUND";
    throw error;
  }

  const stats = storage.getFacilityJobStats(facilityId);
  const active = stats.queued + stats.running;
  if (active > 0) {
    const error = new Error(
      `Cannot remove ${facilityId}: ${active} job(s) are queued or running. Wait for them to finish.`,
    );
    error.code = "ACTIVE_JOBS";
    error.stats = stats;
    throw error;
  }

  if (mode === "account") {
    storage.deleteFacility(facilityId);
    return {
      mode,
      facilityId,
      stats,
      jobsDeleted: 0,
      filesRemoved: [],
      filesSkipped: [],
    };
  }

  if (mode !== "all") {
    throw new Error(`Invalid removal mode: ${mode}`);
  }

  const { jobs } = storage.deleteFacilityData(facilityId);
  const roots = [config.importDir, config.jobsDir, config.outputDir].filter(Boolean);
  const filesRemoved = [];
  const filesSkipped = [];

  for (const job of jobs) {
    const targets = [];
    if (job.inputPath && config.importDir) {
      const inputDirectory = path.dirname(job.inputPath);
      if (isInside(config.importDir, inputDirectory)) {
        targets.push(inputDirectory);
      }
    }
    if (job.id && config.jobsDir) {
      targets.push(path.join(config.jobsDir, job.id));
    }
    if (job.outputDir) {
      targets.push(job.outputDir);
    }

    for (const target of targets) {
      const removed = await removeManagedPath(target, roots, logger);
      (removed ? filesRemoved : filesSkipped).push(target);
    }
  }

  const facilityOutput = config.outputDir
    ? path.join(config.outputDir, facilityId)
    : null;
  if (facilityOutput && isInside(config.outputDir, facilityOutput)) {
    try {
      await fs.rmdir(facilityOutput);
      filesRemoved.push(facilityOutput);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) {
        logger?.warn(`Could not remove ${facilityOutput}: ${error.message}`);
      }
    }
  }

  return {
    mode,
    facilityId,
    stats,
    jobsDeleted: jobs.length,
    filesRemoved,
    filesSkipped,
  };
};

module.exports = { removeFacility };
