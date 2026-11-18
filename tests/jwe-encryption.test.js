'use strict';

const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const { encryptJwe, decryptJwe, getKeyId } = require('../src/encryption');
const { validateSensitivePayload, SENSITIVE_TTL_MS } = require('../src/sensitiveInput');

function makeKeys() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

test('JWE compact message uses RSA-OAEP-256 and A256GCM and round-trips payload', () => {
  const keys = makeKeys();
  const kid = getKeyId(keys.publicKey);
  const payload = { purpose: 'credit-check-identity', identity: { ssn: '123456789', dob: '01/02/1990' } };
  const jwe = encryptJwe(payload, keys.publicKey, kid);
  expect(jwe.split('.')).toHaveLength(5);
  expect(decryptJwe(jwe, keys.privateKey, kid)).toEqual(payload);
});

test('JWE rejects tampered ciphertext and a mismatched key identifier', () => {
  const keys = makeKeys();
  const kid = getKeyId(keys.publicKey);
  const jwe = encryptJwe({ ok: true }, keys.publicKey, kid);
  const parts = jwe.split('.');
  parts[4] = `${parts[4].startsWith('A') ? 'B' : 'A'}${parts[4].slice(1)}`;
  expect(() => decryptJwe(parts.join('.'), keys.privateKey, kid)).toThrow();
  expect(() => decryptJwe(jwe, keys.privateKey, 'wrong-kid')).toThrow(/identifier/);
});

test('sensitive JWE payload is valid for exactly seven minutes', () => {
  const now = Date.now();
  const order = { accountHolder: { ezEnroll: false } };
  const payload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + SENSITIVE_TTL_MS,
    scenario: 'credit-check-identity',
    identity: { ssn: '123456789', dob: '01/02/1990' }
  };
  expect(validateSensitivePayload(payload, order, now + SENSITIVE_TTL_MS - 1)).toBe(true);
  expect(() => validateSensitivePayload(payload, order, now + SENSITIVE_TTL_MS)).toThrow(/expired/i);
});


test('EZ-Enroll payment payload accepts only supported synthetic test-card values', () => {
  const now = Date.now();
  const order = { accountHolder: { ezEnroll: true } };
  const payload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + SENSITIVE_TTL_MS,
    scenario: 'ez-enroll-card',
    payment: {
      cardHolderName: 'Demo Test',
      cardNumber: '4242424242424242',
      expirationMonth: '12',
      expirationYear: String(new Date(now).getFullYear() + 2),
      cvv: '123'
    }
  };
  expect(validateSensitivePayload(payload, order, now)).toBe(true);
  payload.payment.cardNumber = '4111111111111112';
  expect(() => validateSensitivePayload(payload, order, now)).toThrow(/synthetic test-card/i);
});
