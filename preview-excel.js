const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'FlashBuy_Catalog_09JUN2026_13JUN2026_06.48.19.xlsx');
const workbook = XLSX.readFile(filePath);

const sheet = workbook.Sheets[workbook.SheetNames[0]];

// Get the range
console.log('Sheet range:', sheet['!ref']);
console.log('');

// Get merged cells
if (sheet['!merges']) {
  console.log('Merged cells:', JSON.stringify(sheet['!merges'].slice(0, 10)));
}

// Read raw cells to find the actual headers
console.log('\n=== RAW CELLS (first 10 rows) ===');
const cols = 'ABCDEFGHIJKLMNOP';
for (let row = 1; row <= 10; row++) {
  const cells = [];
  for (const col of cols) {
    const cell = sheet[`${col}${row}`];
    if (cell) {
      cells.push(`${col}${row}="${cell.v}"`);
    }
  }
  if (cells.length > 0) {
    console.log(`Row ${row}: ${cells.join(' | ')}`);
  }
}

// Now read with defval to handle empty cells
console.log('\n=== DATA ROWS (using sheet_to_json with raw) ===');
const data = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: '' });
if (data.length > 0) {
  console.log('First row keys:', Object.keys(data[0]));
  console.log('');
  console.log('First 3 data rows:');
  for (let i = 0; i < Math.min(3, data.length); i++) {
    console.log(`  Row ${i}:`, JSON.stringify(data[i]).substring(0, 300));
  }
}
