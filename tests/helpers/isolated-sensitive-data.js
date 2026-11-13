const fs = require('fs');
const os = require('os');
const path = require('path');

async function withIsolatedSensitiveDataStore(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'allconnect-sensitive-test-')
  );
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDirectory = process.env.ALLCONNECT_TEST_RECORDS_DIRECTORY;

  process.env.NODE_ENV = 'test';
  process.env.ALLCONNECT_TEST_RECORDS_DIRECTORY = directory;

  try {
    return await run(directory);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;

    if (previousDirectory === undefined) {
      delete process.env.ALLCONNECT_TEST_RECORDS_DIRECTORY;
    } else {
      process.env.ALLCONNECT_TEST_RECORDS_DIRECTORY = previousDirectory;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { withIsolatedSensitiveDataStore };
