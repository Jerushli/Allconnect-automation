
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const {
  encryptSensitiveValue,
  decryptSensitiveValue
} = require('./encryption');

const DEFAULT_RECORDS_DIRECTORY = path.join(
  __dirname,
  '..',
  'secure-data',
  'records'
);
const TEST_RECORDS_DIRECTORY_ENV = 'ALLCONNECT_TEST_RECORDS_DIRECTORY';

// Test records may only be redirected into a child of the operating-system
// temporary directory. Outside tests, the production secure store remains fixed.
function getRecordsDirectory() {
  const testDirectory = process.env[TEST_RECORDS_DIRECTORY_ENV];
  if (process.env.NODE_ENV !== 'test' || !testDirectory) {
    return DEFAULT_RECORDS_DIRECTORY;
  }

  const resolved = path.resolve(testDirectory);
  const tempRoot = path.resolve(os.tmpdir());
  const relativeToTemp = path.relative(tempRoot, resolved);
  const isStrictTempChild = relativeToTemp !== '' &&
    relativeToTemp !== '..' &&
    !relativeToTemp.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeToTemp);
  const relativeToSecureStore = path.relative(DEFAULT_RECORDS_DIRECTORY, resolved);
  const isInsideSecureStore = relativeToSecureStore === '' ||
    (!path.isAbsolute(relativeToSecureStore) &&
      relativeToSecureStore !== '..' &&
      !relativeToSecureStore.startsWith(`..${path.sep}`));

  if (!isStrictTempChild || isInsideSecureStore) {
    throw new Error('Test sensitive-data storage must be an isolated temporary directory.');
  }

  return resolved;
}

const ALLOWED_PURPOSES = ['ssn', 'dob'];
const AUTHORIZATION_MARKER = Symbol('sensitive-data-authorization');

// Validate the sensitive-data purpose.
function validatePurpose(purpose) {
  if (!ALLOWED_PURPOSES.includes(purpose)) {
    throw new Error('Unsupported sensitive-data purpose.');
  }
}

// Validate UUID record IDs.
function validateRecordId(recordId) {
  if (
    typeof recordId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId)
  ) {
    throw new Error('Invalid sensitive-data record ID.');
  }
}

function getRecordPath(recordId) {
  validateRecordId(recordId);

  return path.join(
    getRecordsDirectory(),
    `${recordId}.json`
  );
}

// Create the encrypted-record directory.
async function ensureRecordsDirectory() {
  await fs.promises.mkdir(getRecordsDirectory(), {
    recursive: true,
    mode: 0o700
  });
}

// Save sensitive data in encrypted form.
async function saveSensitiveData(purpose, value) {
  validatePurpose(purpose);

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A non-empty sensitive value is required.');
  }

  await ensureRecordsDirectory();

  const recordId = crypto.randomUUID();

  const record = {
    recordId,
    purpose,
    createdAt: new Date().toISOString(),
    encryptedData: encryptSensitiveValue(value, purpose)
  };

  const recordPath = getRecordPath(recordId);
  const temporaryPath = `${recordPath}.${crypto.randomUUID()}.tmp`;

  try {
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify(record, null, 2),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      }
    );

    await fs.promises.rename(
      temporaryPath,
      recordPath
    );
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});

    throw new Error('Unable to save encrypted sensitive data.');
  }

  return {
    recordId,
    purpose,
    createdAt: record.createdAt,
    encrypted: true
  };
}

async function readSensitiveRecord(recordPath, recordId, expectedPurpose) {
  validateRecordId(recordId);
  validatePurpose(expectedPurpose);

  let record;

  try {
    const content = await fs.promises.readFile(
      recordPath,
      'utf8'
    );

    record = JSON.parse(content);
  } catch (error) {
    throw new Error('Sensitive-data record could not be retrieved.');
  }

  if (
    record.recordId !== recordId ||
    record.purpose !== expectedPurpose ||
    !record.encryptedData
  ) {
    throw new Error('Sensitive-data record validation failed.');
  }

  return decryptSensitiveValue(
    record.encryptedData,
    expectedPurpose
  );
}

// Check availability without decrypting or returning identity content.
async function inspectSensitiveDataRecord(recordId, expectedPurpose) {
  validateRecordId(recordId);
  validatePurpose(expectedPurpose);

  const recordPath = getRecordPath(recordId);

  let content;
  try {
    content = await fs.promises.readFile(recordPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { available: false, purpose: expectedPurpose };
    }
    throw new Error('Sensitive-data record could not be inspected.');
  }

  let record;
  try {
    record = JSON.parse(content);
  } catch {
    throw new Error('Sensitive-data record validation failed.');
  }

  if (
    record.recordId !== recordId ||
    record.purpose !== expectedPurpose ||
    !record.encryptedData
  ) {
    throw new Error('Sensitive-data record validation failed.');
  }

  return { available: true, purpose: expectedPurpose };
}

// Authorize access using the separate access token.
function authorizeSensitiveDataAccess(accessToken, purpose) {
  validatePurpose(purpose);

  const expectedToken = process.env.SENSITIVE_DATA_ACCESS_TOKEN;

  if (
    typeof expectedToken !== 'string' ||
    expectedToken.length === 0 ||
    typeof accessToken !== 'string'
  ) {
    throw new Error('Sensitive-data authorization failed.');
  }

  const supplied = Buffer.from(accessToken);
  const expected = Buffer.from(expectedToken);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    throw new Error('Sensitive-data authorization failed.');
  }

  return Object.freeze({
    purpose,
    [AUTHORIZATION_MARKER]: true
  });
}

// Authorized one-time consumption.
async function useSensitiveData(
  recordId,
  expectedPurpose,
  authorization,
  consumer
) {
  if (
    !authorization ||
    authorization[AUTHORIZATION_MARKER] !== true ||
    authorization.purpose !== expectedPurpose
  ) {
    throw new Error('Unauthorized sensitive-data access.');
  }

  if (typeof consumer !== 'function') {
    throw new Error('A sensitive-data consumer function is required.');
  }

  const recordPath = getRecordPath(recordId);
  const claimedPath = `${recordPath}.${crypto.randomUUID()}.consuming`;

  // Atomic rename makes concurrent or repeated consumption one-time. If the
  // source is gone, do not retry or silently fall back to another record.
  try {
    await fs.promises.rename(recordPath, claimedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Sensitive-data record is unavailable or already consumed.');
    }
    throw new Error('Sensitive-data record could not be claimed for one-time use.');
  }

  try {
    const value = await readSensitiveRecord(
      claimedPath,
      recordId,
      expectedPurpose
    );
    return await consumer(value);
  } finally {
    await fs.promises.unlink(claimedPath).catch(() => {});
  }
}

// Delete an encrypted record.
async function deleteSensitiveData(recordId) {
  const recordPath = getRecordPath(recordId);

  try {
    await fs.promises.unlink(recordPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw new Error('Unable to delete sensitive-data record.');
  }
}

// Export only the authorized access functions.
module.exports = {
  saveSensitiveData,
  inspectSensitiveDataRecord,
  authorizeSensitiveDataAccess,
  useSensitiveData,
  deleteSensitiveData
};
