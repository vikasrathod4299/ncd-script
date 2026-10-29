const XLSX = require("xlsx");
const fs = require("fs").promises;
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

const DEFAULT_BASE_URL = "https://ncd.mohfw.gov.in";
const DEFAULT_BASIC_AUTH = "TkNEQnJvd3NlcjpTZWN1cmVOQ0Q=";

const decodeJwt = (token) => {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const getTokenExpiry = (token) => {
  const payload = decodeJwt(token);
  return payload?.exp ? payload.exp * 1000 : null;
};

const refreshTokens = async ({
  refreshToken,
  baseUrl = DEFAULT_BASE_URL,
  basicAuth = DEFAULT_BASIC_AUTH,
}) => {
  const formData = new URLSearchParams();
  formData.append("grant_type", "refresh_token");
  formData.append("refresh_token", refreshToken);

  let response;
  try {
    response = await fetch(`${baseUrl}/portal/cphm/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: formData,
    });
  } catch (cause) {
    const error = new Error(`Unable to refresh token: ${cause.message}`);
    error.code = "TOKEN_REFRESH_TRANSIENT";
    error.cause = cause;
    throw error;
  }

  if (!response.ok) {
    const errorDetails = await response.text();
    const error = new Error(`Unable to refresh token: ${errorDetails}`);
    error.status = response.status;
    error.code = [400, 401, 403].includes(response.status)
      ? "AUTH_REFRESH_FAILED"
      : "TOKEN_REFRESH_TRANSIENT";
    throw error;
  }

  return response.json();
};

const createApiClient = async ({
  tokenStore,
  baseUrl = DEFAULT_BASE_URL,
  basicAuth = DEFAULT_BASIC_AUTH,
} = {}) => {
  if (!tokenStore) {
    throw new Error("createApiClient requires a tokenStore");
  }

  let creds = await tokenStore.get();
  let refreshPromise = null;

  const getNewToken = async () => {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const latest = await tokenStore.get();
        if (latest?.access_token && latest.access_token !== creds.access_token) {
          creds = { ...creds, ...latest };
          return latest;
        }

        if (typeof tokenStore.refresh === "function") {
          const json = await tokenStore.refresh();
          creds = { ...creds, ...json };
          return json;
        }

        const json = await refreshTokens({
          refreshToken: latest?.refresh_token || creds.refresh_token,
          baseUrl,
          basicAuth,
        });
        await tokenStore.set(json);
        creds = { ...creds, ...json };
        return json;
      } catch (error) {
        if (!error.code) {
          error.code = "AUTH_REFRESH_FAILED";
        }
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };

  const commonFetch = async (url, method, body, canRetry = true) => {
    const portalOrigin = new URL(baseUrl).origin;
    const headers = {
      Authorization: `Bearer ${creds.access_token}`,
      "User-Agent": "Mozilla/6.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Referer: `${baseUrl}/portal/`,
      host: new URL(baseUrl).host,
      origin: portalOrigin,
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
    throw new Error(`Error fetching data: ${errorBody}`);
  };

  const fetchCbac = async (userId) => {
    return commonFetch(
      `${baseUrl}/portal/cphm/php/individual/${userId}/cbacDetails`,
      "GET",
      null,
    );
  };

  const postCbac = async (row) => {
    const id = row["Individual ID"];
    let body = { ...cbacBodyData[row["Sex"]] };

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
      `${baseUrl}/portal/cphm/php/individual/${id}/cbacDetails`,
      "POST",
      body,
    );
    body = null;
    return res;
  };

  const getScreeningDetails = async (userId) => {
    return commonFetch(
      `${baseUrl}/portal/cphm/php/screeningdetails/individual/${userId}`,
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
  refreshTokens,
  decodeJwt,
  getTokenExpiry,
  ensureDirectory,
  dateFormater,
  DEFAULT_BASE_URL,
  DEFAULT_BASIC_AUTH,
};
