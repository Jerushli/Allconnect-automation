const crypto = require('crypto');
const { test, expect } = require('@playwright/test');

const service = require('../src/sensitiveDataService');
const { withIsolatedSensitiveDataStore } = require('./helpers/isolated-sensitive-data');

test('encrypted records are authorized, inspected without decryption, and consumed once', async () => withIsolatedSensitiveDataStore(async () => {
  const oldKey = process.env.SENSITIVE_DATA_KEY;
  const oldToken = process.env.SENSITIVE_DATA_ACCESS_TOKEN;
  process.env.SENSITIVE_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.SENSITIVE_DATA_ACCESS_TOKEN = crypto.randomBytes(32).toString('hex');

  let ssnRecord;
  let dobRecord;
  const opaqueSsnFixture = `fixture-${crypto.randomUUID()}`;
  const opaqueDobFixture = `fixture-${crypto.randomUUID()}`;

  try {
    ssnRecord = await service.saveSensitiveData('ssn', opaqueSsnFixture);
    dobRecord = await service.saveSensitiveData('dob', opaqueDobFixture);

    expect(await service.inspectSensitiveDataRecord(ssnRecord.recordId, 'ssn'))
      .toEqual({ available: true, purpose: 'ssn' });
    expect(await service.inspectSensitiveDataRecord(dobRecord.recordId, 'dob'))
      .toEqual({ available: true, purpose: 'dob' });

    const ssnAuthorization = service.authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'ssn'
    );
    const dobAuthorization = service.authorizeSensitiveDataAccess(
      process.env.SENSITIVE_DATA_ACCESS_TOKEN,
      'dob'
    );

    let receivedSsn;
    let receivedDob;
    await service.useSensitiveData(
      ssnRecord.recordId,
      'ssn',
      ssnAuthorization,
      async value => { receivedSsn = value; }
    );
    await service.useSensitiveData(
      dobRecord.recordId,
      'dob',
      dobAuthorization,
      async value => { receivedDob = value; }
    );

    expect(receivedSsn).toBe(opaqueSsnFixture);
    expect(receivedDob).toBe(opaqueDobFixture);
    expect(await service.inspectSensitiveDataRecord(ssnRecord.recordId, 'ssn'))
      .toEqual({ available: false, purpose: 'ssn' });
    expect(await service.inspectSensitiveDataRecord(dobRecord.recordId, 'dob'))
      .toEqual({ available: false, purpose: 'dob' });

    await expect(service.useSensitiveData(
      ssnRecord.recordId,
      'ssn',
      ssnAuthorization,
      async () => {}
    )).rejects.toThrow(/unavailable or already consumed/);
  } finally {
    if (ssnRecord) await service.deleteSensitiveData(ssnRecord.recordId).catch(() => {});
    if (dobRecord) await service.deleteSensitiveData(dobRecord.recordId).catch(() => {});
    if (oldKey === undefined) delete process.env.SENSITIVE_DATA_KEY;
    else process.env.SENSITIVE_DATA_KEY = oldKey;
    if (oldToken === undefined) delete process.env.SENSITIVE_DATA_ACCESS_TOKEN;
    else process.env.SENSITIVE_DATA_ACCESS_TOKEN = oldToken;
  }
}));
