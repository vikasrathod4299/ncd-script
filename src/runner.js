const path = require("path");
const fs = require("fs").promises;
const {
  readExcelFile,
  writeExcelFile,
  createApiClient,
  dateFormater,
  ensureDirectory,
} = require("../util.js");
const {
  addPersonalDetails,
  checkPersonalScreening,
  createPayload,
  checkScreening,
  addScreeningDetails,
} = require("../screeningUtil.js");
const { enrichRowsWithRandomData } = require("../generateRandomData.js");
const defaultLogger = require("./logger");

const screeningTypes = [
  "anmPersonalExam",
  "anmPersonalHistory",
  "anmMenstrualHistory",
  "500",
  "600",
  "100",
  "200",
];

const MAX_INITIAL_FAILURES = 5;

const processingDateColumn = "Processing Date";

const addDays = (date, dayCount) => {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + dayCount);
  return nextDate;
};

const assignProcessingDates = (rows, job, logger) => {
  const entriesPerDate = Number.parseInt(`${job.entriesPerDate || 0}`, 10);
  const today = new Date();
  const eligibleRows = rows.filter((row) => row.Age >= 30);
  const totalProcessingDays =
    entriesPerDate > 0 ? Math.ceil(eligibleRows.length / entriesPerDate) : 1;
  const startDate = addDays(today, -(Math.max(totalProcessingDays, 1) - 1));
  logger.info(
    `Assigning processing dates from ${dateFormater(startDate)} to ${dateFormater(today)} for ${eligibleRows.length} eligible entries`,
  );
  let eligibleEntryCount = 0;

  return rows.map((row) => {
    if (row.Age < 30) {
      return row;
    }

    const scheduledOffset =
      entriesPerDate > 0 ? Math.floor(eligibleEntryCount / entriesPerDate) : 0;
    const scheduledDate = addDays(startDate, scheduledOffset);
    eligibleEntryCount += 1;

    return {
      ...row,
      [processingDateColumn]: dateFormater(scheduledDate),
    };
  });
};

const buildOutputPath = (job, date, suffix) => {
  const baseName = path.parse(job.inputFilePath).name;
  const timeStamp = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, "0"))
    .join("-");
  return path.join(
    job.outputDir,
    `${baseName}.${suffix}.${dateFormater(date)}-${timeStamp}.xlsx`,
  );
};

const mapIndexesConcurrently = async ({
  total,
  skipIndexes,
  worker,
  concurrency,
  shouldStop,
}) => {
  let currentIndex = 0;
  let stopped = false;
  let firstError = null;

  const runWorker = async () => {
    while (currentIndex < total && !stopped && !firstError) {
      const index = currentIndex++;
      if (skipIndexes.has(index)) {
        continue;
      }
      try {
        await worker(index);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
        stopped = true;
        break;
      }
      if (shouldStop?.()) {
        stopped = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), total || 1) }, () =>
      runWorker(),
    ),
  );

  if (firstError) {
    throw firstError;
  }
};

const processRow = async (row, rowIndex, apiClient, userContext, logger, dryRun) => {
  logger.info(
    `[${userContext.jobId}] row ${rowIndex + 1}`,
    row["Middle Name"],
    row.Age,
    row["Individual ID"],
  );

  if (row.Age < 30) {
    row["CBAC"] = "skipped-age";
    return row;
  }

  if (dryRun) {
    row["CBAC"] = "dry-run";
    screeningTypes.forEach((type) => {
      row[type] = "dry-run";
    });
    return row;
  }

  try {
    const cbacData = await apiClient.fetchCbac(row["Individual ID"]);
    if (!cbacData.isCbacComplete || !cbacData.isFYCbacComplete) {
      logger.info("Adding/updating CBAC>>>");
      await apiClient.postCbac(row);
      row["CBAC"] = "success";
    } else {
      row["CBAC"] = "already-exists";
    }

    const screeningResults = await screeningOperations(
      row,
      apiClient,
      userContext,
      logger,
    );
    screeningResults.forEach((screeningResult) => {
      row[screeningResult.type] = screeningResult.status;
    });

    const isSuccessEntry =
      screeningResults.some(
        (result) => result.type === "500" && result.status === "success",
      ) &&
      screeningResults.some(
        (result) => result.type === "600" && result.status === "success",
      );

    if (isSuccessEntry && userContext.success) {
      userContext.success.count += 1;
    }
  } catch (error) {
    row["CBAC"] = "failed";
    logger.error(error);
    if (
      error.code === "AUTH_REFRESH_FAILED" ||
      error.code === "AUTH_REQUIRED" ||
      error.code === "TOKEN_REFRESH_TRANSIENT"
    ) {
      throw error;
    }
  }

  return row;
};

const screeningOperations = async (row, apiClient, userContext, logger) => {
  const individualId = row["Individual ID"];
  const screeningReport = [];
  let rescreening = false;
  let screeningId;

  for (const type of screeningTypes) {
    try {
      if (type === "200" && row.Sex === "M") {
        continue;
      }

      if (type === "anmMenstrualHistory" && row.Sex === "M") {
        continue;
      }

      let status;
      const isPersonal = Number.isNaN(Number(type));
      if (isPersonal) {
        status = await checkPersonalScreening(apiClient, individualId, type);
      } else {
        status = await checkScreening(apiClient, individualId, type);
      }

      if (status) {
        if (type === "500" || type === "600") {
          if (status?.screeningId) {
            if (status?.rescreening) {
              logger.info("Adding re-screening>>>");
              screeningId = status.screeningId;
              rescreening = true;
            } else {
              logger.info(`${type} already exist`);
              continue;
            }
          } else {
            logger.info("Adding normal screening>>>");
          }
        } else if (type === "100" || type === "200") {
          if (!status?.screeningId) {
            screeningId = status?.screeningId;
          } else {
            logger.info(`${type} already exist...`);
            continue;
          }
        } else {
          logger.info(`${type} already exist...`);
          continue;
        }
      }

      const payload = createPayload(
        row,
        `${type}${rescreening ? "-RE" : ""}`,
        userContext,
        screeningId,
      );

      if (isPersonal) {
        await addPersonalDetails(apiClient, row, payload, type);
      } else {
        await addScreeningDetails(apiClient, row, payload, type);
      }
      logger.info(`${type} added successfully...`);

      screeningReport.push({ type, status: "success" });
    } catch (error) {
      screeningReport.push({ type, status: "failed" });
      logger.error(error);
    }
  }

  return screeningReport;
};

const loadPreparedRows = async (job, logger) => {
  if (job.preparedPath) {
    try {
      const content = await fs.readFile(job.preparedPath, "utf8");
      return JSON.parse(content);
    } catch {
      logger.warn(`Could not read prepared rows from ${job.preparedPath}, rebuilding`);
    }
  }

  const inputRows = readExcelFile(job.inputFilePath);
  const randomizedRows = enrichRowsWithRandomData(inputRows, {
    overwriteExisting: job.overwriteRandomData,
  });
  const preparedRows = assignProcessingDates(randomizedRows, job, logger);

  if (job.preparedPath) {
    await ensureDirectory(path.dirname(job.preparedPath));
    await fs.writeFile(job.preparedPath, JSON.stringify(preparedRows));
  }

  return preparedRows;
};

const runJob = async (job, options = {}) => {
  const logger = (options.logger || defaultLogger).child(`job:${job.id}`);
  const dryRun = options.dryRun ?? false;
  await ensureDirectory(job.outputDir);

  const preparedRows = await loadPreparedRows(job, logger);
  options.onTotal?.(preparedRows.length);
  const date = new Date();

  if (job.writePreparedSheet) {
    const preparedSheetPath = buildOutputPath(job, date, "prepared");
    writeExcelFile(preparedRows, preparedSheetPath);
    options.onPrepared?.(preparedSheetPath);
  }

  const apiClient =
    options.apiClient ||
    (dryRun
      ? null
      : await createApiClient({
          tokenStore: job.tokenStore,
          baseUrl: job.baseUrl,
          basicAuth: job.basicAuth,
        }));

  logger.info(
    `Processing ${preparedRows.length} rows for ${job.id} with concurrency ${job.concurrency}${
      dryRun ? " (dry run)" : ""
    }`,
  );

  const success = {
    count: options.initialSuccessCount || 0,
    maxEntries: job.successEntries || 0,
    shouldStop: () => success.maxEntries > 0 && success.count >= success.maxEntries,
  };

  const results = new Array(preparedRows.length);
  const doneIndexes = new Set();

  for (const item of options.initialResults || []) {
    if (Number.isInteger(item.index) && preparedRows[item.index]) {
      results[item.index] = item.row;
      doneIndexes.add(item.index);
    }
  }

  let doneCount = doneIndexes.size;
  let closed = false;

  const reportProgress = (index, row) => {
    doneCount += 1;
    options.onRowResult?.({ index, row });
    options.onProgress?.({
      done: doneCount,
      total: preparedRows.length,
      success: success.count,
      row,
      index,
    });
  };

  try {
    await mapIndexesConcurrently({
      total: preparedRows.length,
      skipIndexes: doneIndexes,
      concurrency: Math.max(1, job.concurrency || 1),
      shouldStop: () => success.shouldStop(),
      worker: async (index) => {
        const row = await processRow(
          preparedRows[index],
          index,
          apiClient,
          {
            jobId: job.id,
            userName: job.userName,
            displayName: job.displayName,
            success,
          },
          logger,
          dryRun,
        );
        results[index] = row;
        reportProgress(index, row);

        const initialRows = preparedRows.slice(0, MAX_INITIAL_FAILURES);
        if (
          initialRows.length === MAX_INITIAL_FAILURES &&
          initialRows.every((_, initialIndex) => {
            const initialRow = results[initialIndex];
            return initialRow && initialRow.CBAC === "failed";
          })
        ) {
          const error = new Error(
            `Stopped ${job.id} because the first ${MAX_INITIAL_FAILURES} entries failed. Check the sheet data.`,
          );
          error.code = "JOB_DATA_INVALID";
          throw error;
        }
      },
    });
  } finally {
    const reportPath = buildOutputPath(job, date, "report");
    const reportRows = results.filter(Boolean);
    writeExcelFile(reportRows, reportPath);
    options.onReport?.(reportPath);

    if (success.maxEntries > 0) {
      logger.info(
        `Stopped ${job.id} after ${success.count} success entries (target ${success.maxEntries})`,
      );
    }

    options.onFinish?.({ reportPath, successCount: success.count });
    closed = true;
  }

  return {
    preparedRows,
    results: results.filter(Boolean),
    successCount: success.count,
    closed,
  };
};

module.exports = { runJob, assignProcessingDates, screeningTypes };
