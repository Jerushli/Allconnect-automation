'use strict';

const crypto = require('crypto');
const { encryptJwe, decryptJwe, getKeyId } = require('../src/encryption');

const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const kid = getKeyId(pair.publicKey);
const sample = { purpose: 'jwe-round-trip-test', sample: 'synthetic-only' };
const jwe = encryptJwe(sample, pair.publicKey, kid);
const recovered = decryptJwe(jwe, pair.privateKey, kid);
if (JSON.stringify(recovered) !== JSON.stringify(sample)) {
  throw new Error('JWE round-trip validation failed.');
}
const segments = jwe.split('.');
segments[4] = `${segments[4].startsWith('A') ? 'B' : 'A'}${segments[4].slice(1)}`;
let tamperRejected = false;
try { decryptJwe(segments.join('.'), pair.privateKey, kid); } catch { tamperRejected = true; }
if (!tamperRejected) throw new Error('JWE tamper validation failed.');
console.log('[PASS] JWE RSA-OAEP-256 + A256GCM round trip.');
console.log('[PASS] JWE tamper detection.');
