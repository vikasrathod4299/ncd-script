const { dateFormater } = require("./util.js");


const addPersonalDetails = async (apiClient, data, body, type) => {
  try {
    const id = data["Individual ID"];

    const json = await apiClient.commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/screeningdetails/individual/${id}/${type}`,
      "POST",
      body,
    );

    const screeningId = json?.screeningId;
    return screeningId;
  } catch (e) {
    throw e;
  }
};

const addScreeningDetails = async (apiClient, data, payload, type) => {
  try {
    const individualId = data["Individual ID"];

    const res = await apiClient.commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/condition/${type}/individual/${individualId}/screening`,
      "POST",
      payload,
    );
    const screeningId = res?.screeningId;
    if (screeningId) {
      return screeningId;
    }
    throw new Error(`Screening ID not found -- ${type}`);
  } catch (e) {
    console.log('============> here errror', payload)
    throw e;
  }
};

const checkPersonalScreening = async (apiClient, id, type) => {
  try {
    const json = await apiClient.commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/screeningdetails/individual/${id}/${type}`,
      "GET",
      null,
    );

    if (json.createdUser) {
      return true;
    } else {
      return false;
    }
  } catch (e) {
    throw e;
  }
};

const checkScreening = async (apiClient, id, type) => {
  try {
    const json = await apiClient.commonFetch(
      `https://ncd.mohfw.gov.in/portal/cphm/php/screeningdetails/individual/${id}`,
      "GET",
      null,
    );

    const screeningId = json[type]?.[0].screeningId;

    const rescreening =
      json[type]?.[0]?.rescreeningEligibility?.eligibleForRescreen;

    return { rescreening, screeningId };
  } catch (e) {
    throw e;
  }
};

const createPayload = (data, type, userContext, screeningId = null) => {
  try {
    const date = data["Processing Date"] || dateFormater(new Date());
    const username = userContext.userName;
    const name = userContext.displayName;
    switch (type) {
      case "anmPersonalExam":
        return {
          createdUser: username,
          personalExamDate: date,
          height: data["Height"].toString(),
          weight: data["Weight"].toString(),
          bmi: data["BMI"].toString(),
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: true,
          },
          examination: null,
          referral: false,
        };
      case "anmPersonalHistory":
        return {
          createdUser: username,
        };
      case "anmMenstrualHistory":
        return {
          createdUser: username,
          isMenstrualBleedingHeavy: false,
          isMenstrualBleedingNormal: false,
          menopauseDuration: null,
        };
      case "500":
        return {
          underTreatment: false,
          markKnownCaseFlag: false,
          date,
          referred: false,
          systolic: data["Systolic Blood Pressure"].toString(),
          diastolic: data["Diastolic Blood Pressure"].toString(),
          createdUser: username,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: false,
          },
          examination: null,
          referral: false,
          currentScreeningId: null,
          screeningType: "FirstTime Screening",
        };
      case "500-RE":
        return {
          date: date,
          systolic: data["Systolic Blood Pressure"].toString(),
          diastolic: data["Diastolic Blood Pressure"].toString(),
          pulse: 72,
          diagnosedEarlier: true,
          underTreatment: false,
          referred: false,
          markKnownCaseFlag: false,
          createdUser: username,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: true,
          },
          examination: null,
          referral: null,
          currentScreeningId: screeningId,
          screeningType: "Rescreening",
        };
      case "600":
        return {
          underTreatment: false,
          markKnownCaseFlag: false,
          date,
          referred: false,
          rbs: data["Random Blood Sugar"].toString(),
          createdUser: username,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: false,
          },
          examination: null,
          referral: false,
          currentScreeningId: null,
          screeningType: "FirstTime Screening",
        };
      case "600-RE":
        return {
          underTreatment: false,
          date: date,
          markKnownCaseFlag: false,
          referred: false,
          rbs: data["Random Blood Sugar"].toString(),
          createdUser: username,
          diagnosedEarlier: false,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: false,
          },
          examination: null,
          referral: false,
          currentScreeningId: screeningId,
          screeningType: "Rescreening",
        };
      case "100":
        return {
          symptoms: { anyIssueInMouth: false, date },
          examination: null,
          referral: null,
          createdUser: username,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: false,
          },
          currentScreeningId: null,
          screeningType: "FirstTime Screening",
        };
      case "200":
        return {
          symptoms: {
            anyIssuesInBreast: false,
            date,
          },
          examination: {
            refusedScreening: false,
            lumpPoints: [],
            nippleRetractionPoints: [],
            skinDimplingPoints: [],
            ulcerPoints: [],
            nippleDischargePoints: [],
            armpitSwellingLeft: null,
            armpitSwellingRight: null
          },
          referral: null,
          createdUser: username,
          screeningANM: {
            users: username,
            anmValue: name,
            viaTrained: false,
          },
          currentScreeningId: null,
          screeningType: "FirstTime Screening",
        };
      default:
        return null;
    }
  } catch (e) {
    throw e;
  }
};

module.exports = {
  addPersonalDetails,
  addScreeningDetails,
  checkPersonalScreening,
  checkScreening,
  createPayload,
  dateFormater,
};
