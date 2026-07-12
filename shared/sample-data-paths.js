const fs = require('fs');
const path = require('path');

function getBcSampleDataPath() {
  const localPath = path.join(__dirname, '..', 'sample-data', 'bc_existing_items.local.json');
  const examplePath = path.join(__dirname, '..', 'sample-data', 'bc_existing_items.example.json');

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  return examplePath;
}

module.exports = {
  getBcSampleDataPath,
};
