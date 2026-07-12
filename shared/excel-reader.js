/**
 * PTTEP FlashBuy Excel Reader
 * Reads real PTTEP portal export files (.xlsx)
 */

const XLSX = require('xlsx');

/**
 * Read PTTEP FlashBuy Excel file and return structured items
 */
function readFlashBuyExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  
  // Extract metadata from header area
  const periodCell = sheet['C6'];
  const period = periodCell ? periodCell.v : 'Unknown Period';
  
  // Data starts at row 10 (row 9 is headers, rows 1-8 are title/merged cells)
  // Read raw cells starting from row 10
  const items = [];
  let row = 10;
  
  while (true) {
    const itemNoCell = sheet[`A${row}`];
    if (!itemNoCell) break;
    
    const item = {
      item_no: itemNoCell.v,
      material_code: getCellValue(sheet, `B${row}`),
      material_description: getCellValue(sheet, `C${row}`),
      long_description: getCellValue(sheet, `D${row}`),
      part_number: getCellValue(sheet, `E${row}`),
      manufacturer: getCellValue(sheet, `F${row}`),
      uom: getCellValue(sheet, `G${row}`),
      shelf_life_required: getCellValue(sheet, `H${row}`),
      certificate_required: getCellValue(sheet, `I${row}`),
      pr_number: getCellValue(sheet, `J${row}`),
      total_quantity: getCellValue(sheet, `K${row}`),
      quote_status: getCellValue(sheet, `L${row}`),
      unit_price: getCellValue(sheet, `M${row}`),
      currency: getCellValue(sheet, `N${row}`),
      delivery_lead_time_weeks: getCellValue(sheet, `O${row}`),
    };
    
    items.push(item);
    row++;
  }
  
  return {
    period,
    total_items: items.length,
    items,
  };
}

function getCellValue(sheet, ref) {
  const cell = sheet[ref];
  if (!cell) return '';
  return cell.v !== undefined ? String(cell.v) : '';
}

module.exports = { readFlashBuyExcel };
