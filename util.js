const XLSX = require("xlsx");
const fs = require("fs").promises;
const creds = require("./creds.json");
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

const getNewToken = async () => {
  console.log("refreshing token");
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
      return;
    } else {
      const json = await response.json();
      await fs.writeFile(
        "creds.json",
        JSON.stringify(
          {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
          },
          null,
          2,
        ),
      );
      // Update in-memory creds
      creds.access_token = json.access_token;
      creds.refresh_token = json.refresh_token;
    }
    return;
  } catch (error) {
    console.error("Internal Server Error:", error);
    return;
  }
};

const commonFetch = async (url, method, body) => {
  try {
    const headers = {
      Authorization: `Bearer ${creds.access_token}`,
      "User-Agent":"Mozilla/6.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Referer":"https://ncd.mohfw.gov.in/portal/",
      "host":"ncd.mohfw.gov.in",
      "origin":"https://ncd.mohfw.gov.in",
    };
    const options = { method, headers };
    if (method === "POST") {
      options.body = JSON.stringify(body);
      options.method = method;
      headers["Content-Type"] = "application/json";
      options.headers = headers;
    }

    const data = await fetch(url, options);
    if (data.ok) {
      const json = await data.json();
      return json;
    } else {
      if (data.status === 401) {
        await getNewToken();
        await commonFetch(url, method, body);
      }
      const error = await data.json();
      console.log(url);
      console.log(error);
      throw new Error("Error fetching data", error);
    }
  } catch (e) {
    throw e;
  }
};

const fetchCbac = async (userId) => {
  try {
    const data = await commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/individual/${userId}/cbacDetails`,
      "GET",
      null,
    );
    return data;
  } catch (e) {
    throw e;
  }
};

const postCbac = async (row) => {
  try {
    const id = row["Individual ID"];
    console.log(row["Sex"]);
    let body = {...cbacBodyData[row["Sex"]]};

    body.rskAssmntMdl = {
      ...body.rskAssmntMdl,
      cbacCurDate: dateFormater(new Date()),
    };

    if (row.Age >= 60) {
      body.dtctnMdl = {
        ...body.dtctnMdl,
        ...sinorCitizenData,
      };
    }

    res =  await commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/individual/${id}/cbacDetails`,
      "POST",
      body,
    );
    body = null
    return res
  } catch (e) {
    throw e;
  }
};

const getScreeningDetails = async (userId) => {
  try {
    return await commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/screeningdetails/individual/${userId}`,
      "GET",
      null,
    );
  } catch (e) {
    throw e;
  }
};

module.exports = {
  getNewToken,
  readExcelFile,
  writeExcelFile,
  commonFetch,
  postCbac,
  fetchCbac,
  getScreeningDetails,
  dateFormater
};
