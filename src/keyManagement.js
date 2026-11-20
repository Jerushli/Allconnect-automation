'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getKeyId } = require('./encryption');

const KEY_DIRECTORY = path.join(__dirname, '..', '.local-keys');
const PRIVATE_KEY_PATH = path.join(KEY_DIRECTORY, 'server-private.pem');
const PUBLIC_KEY_PATH = path.join(KEY_DIRECTORY, 'server-public.pem');

function ensureServerKeyPair() {
  fs.mkdirSync(KEY_DIRECTORY, { recursive: true, mode: 0o700 });
  if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
    return loadServerKeyPair();
  }
  if (fs.existsSync(PRIVATE_KEY_PATH) || fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error('JWE key pair is incomplete. Back up and regenerate both server keys.');
  }

  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  fs.writeFileSync(PRIVATE_KEY_PATH, pair.privateKey, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, pair.publicKey, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    kid: getKeyId(pair.publicKey)
  };
}

function loadServerKeyPair() {
  if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error('JWE server keys are missing. Run npm run keys:generate.');
  }
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const publicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
  const derivedPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const suppliedPublicKey = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'pem' });
  if (derivedPublicKey !== suppliedPublicKey) {
    throw new Error('JWE public and private keys do not belong to the same key pair.');
  }
  return { privateKey, publicKey, kid: getKeyId(publicKey) };
}

module.exports = {
  KEY_DIRECTORY,
  PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH,
  ensureServerKeyPair,
  loadServerKeyPair
};
