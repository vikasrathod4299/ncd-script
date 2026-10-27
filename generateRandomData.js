function getRandomInt(min, max) {
  let num = Math.floor(Math.random() * (max - min + 1)) + min;
  if (num % 2 !== 0) {
    num += 1;
    if (num > max) {
      num -= 2;
    }
  }
  return num;
}

function enrichRowWithRandomData(row, options = {}) {
  const overwriteExisting = options.overwriteExisting ?? true;

  const height = getRandomInt(150, 200);
  const weight = getRandomInt(50, 120);
  const bmi = +(weight / ((height / 100) ** 2)).toFixed(2);
  const systolic = getRandomInt(100, 130);
  const diastolic = getRandomInt(70, 89);
  const randomSugar = getRandomInt(90, 120);

  return {
    ...row,
    Height: overwriteExisting ? height : row.Height ?? height,
    Weight: overwriteExisting ? weight : row.Weight ?? weight,
    BMI: overwriteExisting ? bmi : row.BMI ?? bmi,
    "Systolic Blood Pressure": overwriteExisting
      ? systolic
      : row["Systolic Blood Pressure"] ?? systolic,
    "Diastolic Blood Pressure": overwriteExisting
      ? diastolic
      : row["Diastolic Blood Pressure"] ?? diastolic,
    "Random Blood Sugar": overwriteExisting
      ? randomSugar
      : row["Random Blood Sugar"] ?? randomSugar,
  };
}

function enrichRowsWithRandomData(rows, options) {
  return rows.map((row) => enrichRowWithRandomData(row, options));
}

module.exports = {
  getRandomInt,
  enrichRowWithRandomData,
  enrichRowsWithRandomData,
};
