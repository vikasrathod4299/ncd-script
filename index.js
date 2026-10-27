require("dotenv").config();
const path = require("path");
const {
  readExcelFile,
  writeExcelFile,
  createApiClient,
  readJsonFile,
  pathExists,
  listExcelFiles,
  ensureDirectory,
  dateFormater,
} = require("./util.js");
const {
  addPersonalDetails,
  checkPersonalScreening,
  createPayload,
  checkScreening,
  addScreeningDetails,
} = require("./screeningUtil.js");
const { enrichRowsWithRandomData } = require("./generateRandomData.js");

const defaultImportDir = path.resolve(process.env.NCD_IMPORT_DIR || "./import");
const defaultOutputDir = path.resolve(process.env.NCD_OUTPUT_DIR || "./upload");
const jobsFilePath = path.resolve(process.env.NCD_JOBS_FILE || "./jobs.json");
const defaultConcurrency = Number.parseInt(process.env.NCD_CONCURRENCY || "3", 10);

const screeningTypes = [
  "anmPersonalExam",
  "anmPersonalHistory",
  "anmMenstrualHistory",
  "500",
  "600",
  "100",
  "200",
];

const processingDateColumn = "Processing Date";

const buildReportPath = (job, date) => {
  const outputDir = path.resolve(job.outputDir || defaultOutputDir);
  const baseName = path.parse(job.inputFilePath).name;
  const timeStamp = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, "0"))
    .join("-");

  return path.join(
    outputDir,
    `${baseName}.report.${dateFormater(date)}-${timeStamp}.xlsx`,
  );
};

const buildPreparedPath = (job, date) => {
  const outputDir = path.resolve(job.outputDir || defaultOutputDir);
  const baseName = path.parse(job.inputFilePath).name;
  const timeStamp = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, "0"))
    .join("-");

  return path.join(
    outputDir,
    `${baseName}.prepared.${dateFormater(date)}-${timeStamp}.xlsx`,
  );
};

const mapWithConcurrency = async (items, worker, concurrency, shouldStop) => {
  const results = new Array(items.length);
  let currentIndex = 0;
  let stopped = false;

  const runWorker = async () => {
    while (currentIndex < items.length && !stopped) {
      const itemIndex = currentIndex++;
      results[itemIndex] = await worker(items[itemIndex], itemIndex);
      if (shouldStop?.(itemIndex, results[itemIndex])) {
        stopped = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () => runWorker()),
  );

  return results.filter((result) => result !== undefined);
};

const addDays = (date, dayCount) => {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + dayCount);
  return nextDate;
};

const assignProcessingDates = (rows, job) => {
  const entriesPerDate = Number.parseInt(`${job.entriesPerDate || 0}`, 10);
  const today = new Date();
  const eligibleRows = rows.filter((row) => row.Age >= 30);
  console.log(rows.length)
  const totalProcessingDays = entriesPerDate > 0
    ? Math.ceil(eligibleRows.length / entriesPerDate)
    : 1;
  const startDate = addDays(today, -(Math.max(totalProcessingDays, 1) - 1));
  console.log(`Assigning processing dates from ${dateFormater(startDate)} to ${dateFormater(today)} for ${eligibleRows.length} eligible entries`);
  let eligibleEntryCount = 0;

  return rows.map((row) => {
    if (row.Age < 30) {
      return row;
    }

    const scheduledOffset = entriesPerDate > 0
      ? Math.floor(eligibleEntryCount / entriesPerDate)
      : 0;
    const scheduledDate = addDays(startDate, scheduledOffset);
    eligibleEntryCount += 1;

    return {
      ...row,
      [processingDateColumn]: dateFormater(scheduledDate),
    };
  });
};

const buildDefaultJobs = async () => {
  const explicitInputFile = process.env.NCD_INPUT_FILE;
  const inputFiles = explicitInputFile
    ? [path.resolve(explicitInputFile)]
    : await listExcelFiles(defaultImportDir);

  if (inputFiles.length === 0) {
    throw new Error(`No input sheets found in ${defaultImportDir}`);
  }

  if (!explicitInputFile && inputFiles.length > 1) {
    throw new Error(
      "Multiple input sheets found. Create jobs.json so each customer sheet has its own creds.",
    );
  }

  const credsFilePath = path.resolve(process.env.NCD_CREDS_FILE || "./creds.json");
  const userName = process.env.NCD_USER_NAME;
  const displayName = process.env.NCD_NAME;

  if (!userName || !displayName) {
    throw new Error("Set NCD_USER_NAME and NCD_NAME in .env or use jobs.json");
  }

  return inputFiles.map((inputFilePath) => ({
    id: path.parse(inputFilePath).name,
    inputFilePath,
    outputDir: defaultOutputDir,
    credsFilePath,
    userName,
    displayName,
    concurrency: defaultConcurrency,
    entriesPerDate: 0,
    overwriteRandomData: true,
    writePreparedSheet: true,
  }));
};

const loadJobs = async () => {
  if (await pathExists(jobsFilePath)) {
    const jobs = await readJsonFile(jobsFilePath);
    if (!Array.isArray(jobs) || jobs.length === 0) {
      throw new Error("jobs.json must contain a non-empty array");
    }

    return jobs.map((job, index) => ({
      id: job.id || `job-${index + 1}`,
      inputFilePath: path.resolve(job.inputFilePath),
      outputDir: path.resolve(job.outputDir || defaultOutputDir),
      credsFilePath: path.resolve(job.credsFilePath),
      userName: job.userName,
      displayName: job.displayName,
      concurrency: Number.parseInt(`${job.concurrency || defaultConcurrency}`, 10),
      entriesPerDate: Number.parseInt(`${job.entriesPerDate || 0}`, 10),
      successEntries: Number.parseInt(`${job.successEntries || 0}`, 10),
      overwriteRandomData: job.overwriteRandomData ?? true,
      writePreparedSheet: job.writePreparedSheet ?? true,
    }));
  }

  return buildDefaultJobs();
};

const validateJob = async (job) => {
  if (!job.userName || !job.displayName) {
    throw new Error(`Missing userName/displayName for job ${job.id}`);
  }

  if (Number.isNaN(job.concurrency) || job.concurrency < 1) {
    throw new Error(`Invalid concurrency for job ${job.id}`);
  }

  if (Number.isNaN(job.entriesPerDate) || job.entriesPerDate < 0) {
    throw new Error(`Invalid entriesPerDate for job ${job.id}`);
  }

  if (Number.isNaN(job.successEntries) || job.successEntries < 0) {
    throw new Error(`Invalid successEntries for job ${job.id}`);
  }

  if (!(await pathExists(job.inputFilePath))) {
    throw new Error(`Input file not found for job ${job.id}: ${job.inputFilePath}`);
  }

  if (!(await pathExists(job.credsFilePath))) {
    throw new Error(`Creds file not found for job ${job.id}: ${job.credsFilePath}`);
  }

  await ensureDirectory(job.outputDir);
};

const processRow = async (row, rowIndex, apiClient, userContext) => {
  console.log(
    `[${userContext.jobId}] row ${rowIndex + 1}`,
    row["Middle Name"],
    row.Age,
    row["Individual ID"],
  );

  if (row.Age < 30) {
    row["CBAC"] = "skipped-age";
    return row;
  }

  try {
    const cbacData = await apiClient.fetchCbac(row["Individual ID"]);
    console.log("CBAC res", cbacData.isCbacComplete, cbacData.isFYCbacComplete);
    if (!cbacData.isCbacComplete || !cbacData.isFYCbacComplete) {
      console.log("Adding/updating CBAC>>>");
      const res = await apiClient.postCbac(row);
      console.log("CBAC result", res);
      row["CBAC"] = "success";
    } else {
      console.log("CBAC already exist");
      row["CBAC"] = "already-exists";
    }

    const screeningResults = await screeingOprations(row, apiClient, userContext);
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

    console.log("done", row["Middle Name"]);
  } catch (error) {
    row["CBAC"] = "failed";
    console.error(error);
    if (error.code === "AUTH_REFRESH_FAILED") {
      throw error;
    }
  }

  return row;
};


async function main() {
  const jobs = await loadJobs();

  for (const job of jobs) {
    await validateJob(job);
    const date = new Date();
    const apiClient = await createApiClient(job.credsFilePath);
    const inputRows = readExcelFile(job.inputFilePath);
    const randomizedRows = enrichRowsWithRandomData(inputRows, {
      overwriteExisting: job.overwriteRandomData,
    });
    const preparedRows = assignProcessingDates(randomizedRows, job);

    if (job.writePreparedSheet) {
      writeExcelFile(preparedRows, buildPreparedPath(job, date));
    }

    console.log(
      `Processing ${preparedRows.length} rows for ${job.id} with concurrency ${job.concurrency}`,
    );

    const success = {
      count: 0,
      maxEntries: job.successEntries || 0,
      shouldStop: () => success.maxEntries > 0 && success.count >= success.maxEntries,
    };

    const result = await mapWithConcurrency(
      preparedRows,
      (row, rowIndex) =>
        processRow(row, rowIndex, apiClient, {
          jobId: job.id,
          userName: job.userName,
          displayName: job.displayName,
          success,
        }),
      Math.max(1, job.concurrency || defaultConcurrency),
      () => success.shouldStop(),
    );

    if (success.maxEntries > 0) {
      console.log(
        `Stopped ${job.id} after ${success.count} success entries (target ${success.maxEntries})`,
      );
    }

    writeExcelFile(result, buildReportPath(job, date));
  }

  console.log("All done");
}

const screeingOprations = async (row, apiClient, userContext) => {
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
      const isPersonal = isNaN(Number(type));
      if (isPersonal) {
        status = await checkPersonalScreening(apiClient, individualId, type);
      } else {
        status = await checkScreening(apiClient, individualId, type);
      }

      if (status) {
        if (type === "500" || type === "600") {
          if (status?.screeningId) {
            if (status?.rescreening) {
              console.log("Adding re-screening>>>");
              screeningId = status.screeningId;
              rescreening = true;
            } else {
              console.log(`${type} already exist`);
              continue;
            }
          } else {
            console.log("Adding normal screening>>>");
          }
        } else {
          if (type === "100" || type === "200") {
            if (!status?.screeningId) {
              screeningId = status.screeningId;
            } else {
              console.log(`${type} aleady exist...`);
              continue;
            }
          } else {
            console.log(`${type} aleady exist...`);
            continue;
          }
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
      console.log(`${type} added successfully...`);

      screeningReport.push({ type, status: "success" });

    } catch (e) {
      screeningReport.push({ type, status: "failed" });
      console.error(e);
      continue;
    }
  }
  return screeningReport;
};

main().catch((err) => console.error(err));
