'use strict';

const { ensureServerKeyPair, PRIVATE_KEY_PATH, PUBLIC_KEY_PATH } = require('../src/keyManagement');

try {
  const pair = ensureServerKeyPair();
  console.log('\n[JWE] Server RSA key pair is ready.');
  console.log(`[JWE] Private key: ${PRIVATE_KEY_PATH}`);
  console.log(`[JWE] Public key:  ${PUBLIC_KEY_PATH}`);
  console.log(`[JWE] Key ID:      ${pair.kid}`);
  console.log('[JWE] Keep the private key on the backend only. Do not share or commit it.');
} catch (error) {
  console.error('[JWE] Key generation failed:', error.message);
  process.exitCode = 1;
}
