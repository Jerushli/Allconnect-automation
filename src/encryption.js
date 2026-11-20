'use strict';

// JWE Compact Serialization using RSA-OAEP-256 + A256GCM.
// The client encrypts a fresh AES-256 content-encryption key with the
// receiving server's RSA public key. Only that server's private key can unwrap it.

const crypto = require('crypto');

const JWE_ALG = 'RSA-OAEP-256';
const JWE_ENC = 'A256GCM';

function base64urlEncode(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Invalid JWE base64url segment.');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64');
}

function getKeyId(publicKeyPem) {
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return base64urlEncode(crypto.createHash('sha256').update(der).digest()).slice(0, 22);
}

function encryptJwe(payload, publicKeyPem, kid = getKeyId(publicKeyPem)) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('JWE payload must be a JSON object.');
  }
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('PUBLIC KEY')) {
    throw new Error('A valid server public key is required for JWE encryption.');
  }

  const protectedHeader = {
    alg: JWE_ALG,
    enc: JWE_ENC,
    kid,
    typ: 'JWE'
  };
  const protectedSegment = base64urlEncode(Buffer.from(JSON.stringify(protectedHeader), 'utf8'));
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const encryptedKey = crypto.publicEncrypt({
    key: publicKeyPem,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, cek);

  const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(protectedSegment, 'ascii'));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  cek.fill(0);
  plaintext.fill(0);

  return [
    protectedSegment,
    base64urlEncode(encryptedKey),
    base64urlEncode(iv),
    base64urlEncode(ciphertext),
    base64urlEncode(tag)
  ].join('.');
}

function decryptJwe(compactJwe, privateKeyPem, expectedKid) {
  if (typeof compactJwe !== 'string' || compactJwe.length > 65536) {
    throw new Error('Invalid or oversized JWE message.');
  }
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('The server private key is not configured.');
  }

  const parts = compactJwe.split('.');
  if (parts.length !== 5) throw new Error('JWE must use compact serialization.');

  const [protectedSegment, encryptedKeySegment, ivSegment, ciphertextSegment, tagSegment] = parts;
  let header;
  try {
    header = JSON.parse(base64urlDecode(protectedSegment).toString('utf8'));
  } catch {
    throw new Error('JWE protected header is invalid.');
  }

  if (header.alg !== JWE_ALG || header.enc !== JWE_ENC || header.typ !== 'JWE') {
    throw new Error('JWE algorithms or message type are not supported.');
  }
  if (expectedKid && header.kid !== expectedKid) {
    throw new Error('JWE key identifier does not match this server.');
  }

  const cek = crypto.privateDecrypt({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, base64urlDecode(encryptedKeySegment));

  if (cek.length !== 32) {
    cek.fill(0);
    throw new Error('JWE content-encryption key has an invalid length.');
  }

  try {
    const iv = base64urlDecode(ivSegment);
    const ciphertext = base64urlDecode(ciphertextSegment);
    const tag = base64urlDecode(tagSegment);
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('JWE IV or authentication tag has an invalid length.');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', cek, iv);
    decipher.setAAD(Buffer.from(protectedSegment, 'ascii'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    try {
      return JSON.parse(plaintext.toString('utf8'));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error('JWE authentication or decryption failed.');
  } finally {
    cek.fill(0);
  }
}

module.exports = {
  JWE_ALG,
  JWE_ENC,
  base64urlEncode,
  base64urlDecode,
  getKeyId,
  encryptJwe,
  decryptJwe
};
