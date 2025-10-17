// import necessary modules  with commonJS syntax

const XLSX = require('xlsx');

// Function to generate random integers in a given range
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Load Excel file
const filePath = './import/pgTest3.xlsx';
const workbook = XLSX.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

// Add new random columns
const updatedData = sheet.map(row => {
  const height = getRandomInt(150, 200); // cm
  const weight = getRandomInt(50, 120); // kg
  const bmi = +(weight / ((height / 100) ** 2)).toFixed(2);
  const systolic = getRandomInt(90, 140);
  const diastolic = getRandomInt(60, 80);
  const randomSugar = getRandomInt(70, 140);

  return {
    ...row,
    Height: height,
    Weight: weight,
    BMI: bmi,
    'Systolic Blood Pressure': systolic,
    'Diastolic Blood Pressure': diastolic,
    'Random Blood Sugar': randomSugar
  };
});

// Create a new worksheet and workbook
const newSheet = XLSX.utils.json_to_sheet(updatedData);
const newWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(newWorkbook, newSheet, 'UpdatedData');

// Save to a new Excel file
const outputPath = './upload/Pgtest3.xlsx';
XLSX.writeFile(newWorkbook, outputPath);

console.log(`✅ Updated file saved to: ${outputPath}`);

module.exports = getRandomInt;