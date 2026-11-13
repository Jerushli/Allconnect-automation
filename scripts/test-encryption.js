
require('dotenv').config();
const crypto = require('crypto');

const {
  encryptSensitiveValue,
  decryptSensitiveValue
} = require('../src/encryption');

function runTest() {
  console.log('\n================================');
  console.log('ALLCONNECT ENCRYPTION POC');
  console.log('================================');

  // Generate ephemeral synthetic fixtures; never hardcode or print identity values.
  const dummySSN = Array.from({ length: 9 }, (_, index) =>
    String(crypto.randomInt(index === 0 ? 1 : 0, 10))
  ).join('');
  const dummyDOB = new Date(
    Date.UTC(1975, 0, 1) + crypto.randomInt(0, 25 * 365) * 86400000
  ).toISOString().slice(0, 10);

  // Encrypt
  const encryptedSSN = encryptSensitiveValue(
    dummySSN,
    'ssn'
  );

  const encryptedDOB = encryptSensitiveValue(
    dummyDOB,
    'dob'
  );

  console.log('[PASS] Synthetic SSN encrypted.');
  console.log('[PASS] Synthetic DOB encrypted.');

  // Verify ciphertext does not contain original plaintext.
  if (JSON.stringify(encryptedSSN).includes(dummySSN)) {
    throw new Error('SSN plaintext exposure detected.');
  }

  if (JSON.stringify(encryptedDOB).includes(dummyDOB)) {
    throw new Error('DOB plaintext exposure detected.');
  }

  console.log('[PASS] Plaintext not present in ciphertext.');

  // Decrypt
  const decryptedSSN = decryptSensitiveValue(
    encryptedSSN,
    'ssn'
  );

  const decryptedDOB = decryptSensitiveValue(
    encryptedDOB,
    'dob'
  );

  if (decryptedSSN !== dummySSN) {
    throw new Error('SSN decryption verification failed.');
  }

  if (decryptedDOB !== dummyDOB) {
    throw new Error('DOB decryption verification failed.');
  }

  console.log('[PASS] SSN decryption verified.');
  console.log('[PASS] DOB decryption verified.');

  // Verify authentication rejects tampering.
  const tamperedData = {
    ...encryptedSSN,
    ciphertext: encryptedSSN.ciphertext.slice(0, -4) + 'AAAA'
  };

  let tamperingRejected = false;

  try {
    decryptSensitiveValue(tamperedData, 'ssn');
  } catch {
    tamperingRejected = true;
  }

  if (!tamperingRejected) {
    throw new Error('Tampered ciphertext was accepted.');
  }

  console.log('[PASS] Tampered ciphertext rejected.');

  console.log('\n================================');
  console.log('ALL ENCRYPTION TESTS PASSED');
  console.log('================================');
}

try {
  runTest();
} catch (error) {
  console.error('Encryption POC failed:', error.message);
  process.exitCode = 1;
}
