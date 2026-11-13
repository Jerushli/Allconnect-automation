
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function getEncryptionKey() {
  const encodedKey = process.env.SENSITIVE_DATA_KEY;

  if (!encodedKey) {
    throw new Error('SENSITIVE_DATA_KEY is not configured.');
  }

  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== 32) {
    throw new Error(
      'SENSITIVE_DATA_KEY must decode to exactly 32 bytes.'
    );
  }

  return key;
}

function getAdditionalData(purpose) {
  const allowedPurposes = ['ssn', 'dob'];

  if (!allowedPurposes.includes(purpose)) {
    throw new Error('Unsupported sensitive-data purpose.');
  }

  return Buffer.from(
    `allconnect:${VERSION}:${purpose}`,
    'utf8'
  );
}

function encryptSensitiveValue(value, purpose) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A non-empty string is required.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    key,
    iv
  );

  cipher.setAAD(getAdditionalData(purpose));

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return {
    version: VERSION,
    algorithm: ALGORITHM,
    purpose,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64')
  };
}

function decryptSensitiveValue(encryptedData, expectedPurpose) {
  if (!encryptedData || encryptedData.version !== VERSION) {
    throw new Error('Invalid or unsupported encrypted data.');
  }

  if (encryptedData.algorithm !== ALGORITHM) {
    throw new Error('Unsupported encryption algorithm.');
  }

  if (encryptedData.purpose !== expectedPurpose) {
    throw new Error('Sensitive-data purpose mismatch.');
  }

  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encryptedData.iv, 'base64')
  );

  decipher.setAAD(getAdditionalData(expectedPurpose));

  decipher.setAuthTag(
    Buffer.from(encryptedData.authTag, 'base64')
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedData.ciphertext, 'base64')
    ),
    decipher.final()
  ]);

  try {
    return decrypted.toString('utf8');
  } finally {
    decrypted.fill(0);
  }
}

module.exports = {
  encryptSensitiveValue,
  decryptSensitiveValue
};
