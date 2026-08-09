const XLSX = require("xlsx");
const fs = require("fs").promises;
const path = require("path");
const cbacBodyData = require("./cbacData.json");
const sinorCitizenData = require("./senior-citizen-cbac.json");

const dateFormater = (date) => {
  const formattedDate =
    date.getDate().toString().padStart(2, "0") +
    "-" +
    (date.getMonth() + 1).toString().padStart(2, "0") +
    "-" +
    date.getFullYear();
  return formattedDate;
};

const readExcelFile = (filePath) => {
  const workbook = XLSX.readFile(filePath);

  const sheetName = workbook.SheetNames[0];

  const sheet = workbook.Sheets[sheetName];

  const jsonData = XLSX.utils.sheet_to_json(sheet);

  return jsonData;
};

const writeExcelFile = (data, filePath) => {
  const ws = XLSX.utils.json_to_sheet(data);

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

  XLSX.writeFile(wb, filePath);
};

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const readJsonFile = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
};

const pathExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const listExcelFiles = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.xlsx$/i.test(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
};

const createApiClient = async (credsFilePath) => {
  const absoluteCredsPath = path.resolve(credsFilePath);
  const creds = await readJsonFile(absoluteCredsPath);
  let refreshPromise = null;
  let authRefreshError = null;

  const getNewToken = async () => {
    if (authRefreshError) {
      throw authRefreshError;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      console.log(`refreshing token from ${absoluteCredsPath}`);
      const formData = new URLSearchParams();
      formData.append("grant_type", "refresh_token");
      formData.append("refresh_token", creds.refresh_token);

      try {
        const response = await fetch(
          "https://ncd.mohfw.gov.in/portal/cphm/oauth/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: "Basic TkNEQnJvd3NlcjpTZWN1cmVOQ0Q=",
            },
            body: formData,
          },
        );

        if (!response.ok) {
          console.log("Not able to refresh token");
          const errorDetails = await response.text();
          console.error("Error Response:", errorDetails);
          const error = new Error("Unable to refresh token");
          error.code = "AUTH_REFRESH_FAILED";
          throw error;
        }

        const json = await response.json();
        await fs.writeFile(
          absoluteCredsPath,
          JSON.stringify(
            {
              access_token: json.access_token,
              refresh_token: json.refresh_token,
            },
            null,
            2,
          ),
        );
        creds.access_token = json.access_token;
        creds.refresh_token = json.refresh_token;
        authRefreshError = null;
        return json;
      } catch (error) {
        authRefreshError = error;
        console.error("Internal Server Error:", error);
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };

  const commonFetch = async (url, method, body, canRetry = true) => {
    if (authRefreshError) {
      throw authRefreshError;
    }

    const headers = {
      Authorization: `Bearer ${creds.access_token}`,
      "User-Agent": "Mozilla/6.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Referer: "https://ncd.mohfw.gov.in/portal/",
      host: "ncd.mohfw.gov.in",
      origin: "https://ncd.mohfw.gov.in",
    };
    const options = { method, headers };

    if (method === "POST") {
      options.body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, options);
    if (response.ok) {
      return response.json();
    }

    if (response.status === 401 && canRetry) {
      await getNewToken();
      return commonFetch(url, method, body, false);
    }

    const errorBody = await response.text();
    console.log(url);
    console.log(errorBody);
    throw new Error(`Error fetching data: ${errorBody}`);
  };

  const fetchCbac = async (userId) => {
    return commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/individual/${userId}/cbacDetails`,
      "GET",
      null,
    );
  };

  const postCbac = async (row) => {
    const id = row["Individual ID"];
    console.log(row["Sex"]);
    let body = { ...cbacBodyData[row["Sex"]] };

    console.log("Cbac date >>>>>>>>", row["Processing Date"]);
    body.rskAssmntMdl = {
      ...body.rskAssmntMdl,
      cbacCurDate: row["Processing Date"] || dateFormater(new Date()),
    };

    if (row.Age >= 60) {
      body.dtctnMdl = {
        ...body.dtctnMdl,
        ...sinorCitizenData,
      };
    }

    const res = await commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/individual/${id}/cbacDetails`,
      "POST",
      body,
    );
    body = null;
    return res;
  };

  const getScreeningDetails = async (userId) => {
    return commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/screeningdetails/individual/${userId}`,
      "GET",
      null,
    );
  };

  return {
    commonFetch,
    fetchCbac,
    postCbac,
    getScreeningDetails,
    getNewToken,
  };
};

module.exports = {
  readExcelFile,
  writeExcelFile,
  createApiClient,
  readJsonFile,
  pathExists,
  listExcelFiles,
  ensureDirectory,
  dateFormater,
};
