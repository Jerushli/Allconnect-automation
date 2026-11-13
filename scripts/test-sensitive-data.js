
require('dotenv').config();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  saveSensitiveData,
  authorizeSensitiveDataAccess,
  useSensitiveData,
  deleteSensitiveData
} = require('../src/sensitiveDataService');

const RECORDS_DIRECTORY = path.join(
  __dirname,
  '..',
  'secure-data',
  'records'
);

async function main() {
  const createdRecords = [];
  const fixtures = {
    ssn: `opaque-${crypto.randomUUID()}`,
    dob: `opaque-${crypto.randomUUID()}`,
    wrongPurpose: `opaque-${crypto.randomUUID()}`,
    wrongKey: `opaque-${crypto.randomUUID()}`,
    tampered: `opaque-${crypto.randomUUID()}`
  };

  let originalEncryptionKey;

  try {
    console.log('\nALLCONNECT SENSITIVE DATA POC');

    if (!process.env.SENSITIVE_DATA_ACCESS_TOKEN) {
      throw new Error('SENSITIVE_DATA_ACCESS_TOKEN is not configured.');
    }

    if (!process.env.SENSITIVE_DATA_KEY) {
      throw new Error('SENSITIVE_DATA_KEY is not configured.');
    }

    // TEST 1: Save an opaque fixture under the SSN purpose.
    const ssnRecord = await saveSensitiveData(
      'ssn',
      fixtures.ssn
    );

    createdRecords.push(ssnRecord);

    console.log('[PASS] Dummy SSN saved as encrypted record.');

    // TEST 2: Save an opaque fixture under the DOB purpose.
    const dobRecord = await saveSensitiveData(
      'dob',
      fixtures.dob
    );

    createdRecords.push(dobRecord);

    console.log('[PASS] Dummy DOB saved as encrypted record.');

    // TEST 3: Verify plaintext is not stored.
    const ssnFile = await fs.promises.readFile(
      path.join(RECORDS_DIRECTORY, `${ssnRecord.recordId}.json`),
      'utf8'
    );

    const dobFile = await fs.promises.readFile(
      path.join(RECORDS_DIRECTORY, `${dobRecord.recordId}.json`),
      'utf8'
    );

    assert.strictEqual(ssnFile.includes(fixtures.ssn), false);
    assert.strictEqual(dobFile.includes(fixtures.dob), false);

    console.log('[PASS] Stored records contain no plaintext.');

    // TEST 4: Authorized SSN decryption.
    const ssnAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'ssn'
    );

    let decryptedSSN;

    await useSensitiveData(
      ssnRecord.recordId,
      'ssn',
      ssnAuthorization,
      async value => {
        decryptedSSN = value;
      }
    );

    assert.strictEqual(decryptedSSN, fixtures.ssn);

    console.log('[PASS] SSN decryption verified.');

    // TEST 5: Authorized DOB decryption.
    const dobAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'dob'
    );

    let decryptedDOB;

    await useSensitiveData(
      dobRecord.recordId,
      'dob',
      dobAuthorization,
      async value => {
        decryptedDOB = value;
      }
    );

    assert.strictEqual(decryptedDOB, fixtures.dob);

    console.log('[PASS] DOB decryption verified.');

    // TEST 6: Wrong purpose must be rejected.
    const wrongPurposeRecord = await saveSensitiveData(
      'ssn',
      fixtures.wrongPurpose
    );

    createdRecords.push(wrongPurposeRecord);

    const dobPurposeAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'dob'
    );

    await assert.rejects(
      useSensitiveData(
        wrongPurposeRecord.recordId,
        'dob',
        dobPurposeAuthorization,
        async () => {}
      ),
      /validation failed/
    );

    console.log('[PASS] Wrong purpose rejected.');

    // TEST 7: Incorrect encryption key must fail decryption.
    const wrongKeyRecord = await saveSensitiveData(
      'ssn',
      fixtures.wrongKey
    );

    createdRecords.push(wrongKeyRecord);

    const wrongKeyAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'ssn'
    );

    originalEncryptionKey = process.env.SENSITIVE_DATA_KEY;

    let wrongEncryptionKey;

    do {
      wrongEncryptionKey = crypto.randomBytes(32).toString('base64');
    } while (wrongEncryptionKey === originalEncryptionKey);

    process.env.SENSITIVE_DATA_KEY = wrongEncryptionKey;

    await assert.rejects(
      useSensitiveData(
        wrongKeyRecord.recordId,
        'ssn',
        wrongKeyAuthorization,
        async () => {}
      )
    );

    process.env.SENSITIVE_DATA_KEY = originalEncryptionKey;
    originalEncryptionKey = undefined;

    console.log('[PASS] Incorrect encryption key rejected.');

    // TEST 8: Tampered ciphertext must fail authentication.
    const tamperedRecord = await saveSensitiveData(
      'dob',
      fixtures.tampered
    );

    createdRecords.push(tamperedRecord);

    const tamperedAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'dob'
    );

    const tamperedPath = path.join(
      RECORDS_DIRECTORY,
      `${tamperedRecord.recordId}.json`
    );

    const tamperedContent = JSON.parse(
      await fs.promises.readFile(tamperedPath, 'utf8')
    );

    const originalCiphertext = tamperedContent.encryptedData.ciphertext;

    tamperedContent.encryptedData.ciphertext =
      (originalCiphertext[0] === 'A' ? 'B' : 'A') +
      originalCiphertext.slice(1);

    await fs.promises.writeFile(
      tamperedPath,
      JSON.stringify(tamperedContent, null, 2),
      'utf8'
    );

    await assert.rejects(
      useSensitiveData(
        tamperedRecord.recordId,
        'dob',
        tamperedAuthorization,
        async () => {}
      )
    );

    console.log('[PASS] Tampered stored record rejected.');

    console.log('\nALL SENSITIVE DATA TESTS PASSED');
  } finally {
    // Restore the original encryption key if a test failed.
    if (originalEncryptionKey !== undefined) {
      process.env.SENSITIVE_DATA_KEY = originalEncryptionKey;
    }

    // Delete every test record.
    for (const record of createdRecords) {
      await deleteSensitiveData(record.recordId).catch(() => {});
    }

    console.log('[CLEANUP] Test records removed.');
  }
}

main().catch(error => {
  console.error('[FAILED]', error.message);
  process.exitCode = 1;
});
