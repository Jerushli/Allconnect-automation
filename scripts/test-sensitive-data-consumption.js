
require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');

const {
  saveSensitiveData,
  authorizeSensitiveDataAccess,
  useSensitiveData,
  deleteSensitiveData
} = require('../src/sensitiveDataService');

async function main() {
  let successfulRecord;
  let failedRecord;
  const ssnFixture = `opaque-${crypto.randomUUID()}`;
  const dobFixture = `opaque-${crypto.randomUUID()}`;

  try {
    console.log('\nSENSITIVE DATA ONE-TIME CONSUMPTION TEST');

    // TEST 1: Successful one-time consumption.
    successfulRecord = await saveSensitiveData(
      'ssn',
      ssnFixture
    );

    const ssnAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'ssn'
    );

    const result = await useSensitiveData(
      successfulRecord.recordId,
      'ssn',
      ssnAuthorization,
      async value => {
        assert.strictEqual(value, ssnFixture);

        console.log('[PASS] Decrypted value delivered to authorized consumer.');

        return 'consumer-completed';
      }
    );

    assert.strictEqual(result, 'consumer-completed');

    assert.strictEqual(
      await deleteSensitiveData(successfulRecord.recordId),
      false
    );

    console.log('[PASS] Successfully consumed record deleted.');

    // TEST 2: Consumer failure must still delete the record.
    failedRecord = await saveSensitiveData(
      'dob',
      dobFixture
    );

    const dobAuthorization = authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'dob'
    );

    await assert.rejects(
      useSensitiveData(
        failedRecord.recordId,
        'dob',
        dobAuthorization,
        async value => {
          assert.strictEqual(value, dobFixture);

          throw new Error('Synthetic consumer failure.');
        }
      ),
      /Synthetic consumer failure/
    );

    assert.strictEqual(
      await deleteSensitiveData(failedRecord.recordId),
      false
    );

    console.log('[PASS] Record deleted after consumer failure.');

    console.log('\nALL CONSUMPTION TESTS PASSED');
  } finally {
    // Cleanup if an earlier assertion fails.
    if (successfulRecord) {
      await deleteSensitiveData(successfulRecord.recordId).catch(() => {});
    }

    if (failedRecord) {
      await deleteSensitiveData(failedRecord.recordId).catch(() => {});
    }
  }
}

main().catch(error => {
  console.error('[FAILED]', error.message);
  process.exitCode = 1;
});
