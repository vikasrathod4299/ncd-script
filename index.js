const {
  readExcelFile,
  writeExcelFile,
  fetchCbac,
  dateFormater,
  postCbac,
} = require("./util.js");
require('./generateRandomData.js')
const filePath = "./upload/Pgtest3.xlsx";
const data = readExcelFile(filePath);
const {
  addPersonalDetails,
  checkPersonalScreening,
  createPayload,
  checkScreening,
  addScreeningDetails,
} = require("./screeningUtil.js");
const { default: getRandomInt } = require("./generateRandomData.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const screeningTypes = [
  "anmPersonalExam",
  "anmPersonalHistory",
  "anmMenstrualHistory",
  "500",
  "600",
  "100",
  "200",
];


async function main() {
  const date = new Date();
  let count = 0;
  const result = [];
  for (const row of data) {
    console.log(count, row["Middle Name"], row.Age, row["Individual ID"]);
    if (row.Age >= 30) {
      try {
        const cbacData = await fetchCbac(row["Individual ID"]);
        if (!cbacData.isCbacComplete || !cbacData.isFYCbacComplete) {
          const res = await postCbac(row);
          console.log("CBAC result", res);
          row["CBAC"] = "success";
        }else {
          console.log("CBAC already exist");
        }

        //Fetch screening details
        const res = await screeingOprations(row);
        res.forEach((r) => {
          row[r.type] = r.status;
        });
        console.log("done", row["Middle Name"]);
      } catch (error) {
        row["CBAC"] = "failed";
        console.error(error);
      }
      count++;
    }
    result.push(row);
  }

  writeExcelFile(result, `./upload/Pgtest3Report-${dateFormater(date)}.xlsx`);
  console.log("All done");
}

const screeingOprations = async (row) => {
  const individualId = row["Individual ID"];
  const screeningReport = [];
  let rescreening = false;
  let screeningId;

  for (const type of screeningTypes) {
    try {

      if (type === "200" && row.Sex === "M") {
        continue;
      }

      if(type === "anmMenstrualHistory" && row.Sex === "M"){
        continue;
      }

      let status;
      const isPersonal = isNaN(Number(type));
      if (isPersonal) {
        status = await checkPersonalScreening(individualId, type);
      } else {
        status = await checkScreening(individualId, type);
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
            if(!status?.screeningId){
              screeningId = status.screeningId;
            }else{
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
        screeningId,
      );

      if (isPersonal) {
        await addPersonalDetails(row, payload, type);
      } else {
        await addScreeningDetails(row, payload, type);
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