'use strict';

const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const sampleOrder = require('../test-data/sample-order.json');
const { createApp } = require('../src/server');
const { encryptJwe, getKeyId } = require('../src/encryption');
const { SENSITIVE_TTL_MS } = require('../src/sensitiveInput');

let server;
let baseUrl;
let capturedInput;
const token = 'jwe-test-api-token';
const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const keys = { ...pair, kid: getKeyId(pair.publicKey) };

function identityPayload(now = Date.now()) {
  return {
    version: 1,
    issuedAt: now,
    expiresAt: now + SENSITIVE_TTL_MS,
    scenario: 'credit-check-identity',
    identity: { ssn: '123456789', dob: '01/02/1990' }
  };
}

async function postScenario(payload) {
  const jwe = encryptJwe(payload, keys.publicKey, keys.kid);
  return fetch(`${baseUrl}/api/scenarios/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ order: sampleOrder, sensitiveJwe: jwe })
  });
}

test.describe('JWE scenario API', () => {
  test.beforeAll(async () => {
    const app = createApp({
      apiToken: token,
      jweKeys: keys,
      runAutomation: async input => {
        // The API deliberately zeroes decrypted secrets after the runner returns.
        // Snapshot only inside the runner so this test verifies delivery without
        // requiring sensitive values to remain in memory after completion.
        capturedInput = {
          sensitiveData: {
            identity: input.sensitiveData?.identity
              ? { ...input.sensitiveData.identity }
              : undefined,
            payment: input.sensitiveData?.payment
              ? { ...input.sensitiveData.payment }
              : undefined
          }
        };
        return { status: 'completed', summary: {}, steps: [], safetyCheckpoint: {} };
      }
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('publishes only the server public key and matching key ID', async () => {
    const response = await fetch(`${baseUrl}/api/crypto/public-key`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.publicKey).toContain('PUBLIC KEY');
    expect(body.kid).toBe(keys.kid);
    expect(body).not.toHaveProperty('privateKey');
  });

  test('decrypts JWE on the backend and passes sensitive values to the runner', async () => {
    const response = await postScenario(identityPayload());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe('completed');
    expect(capturedInput.sensitiveData.identity).toEqual({ ssn: '123456789', dob: '01/02/1990' });
  });

  test('rejects invalid decrypted identity with a safe failure code and writes a report', async () => {
    const invalid = identityPayload();
    invalid.identity.dob = '02/31/1990';
    const response = await postScenario(invalid);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.failureStage).toBe('input_validation');
    expect(body.failureType).toBe('input_validation');
    expect(body.failureCode).toBe('DOB_DATE_INVALID');
    expect(body.reportSaved).toBe(true);
    expect(JSON.stringify(body)).not.toContain('123456789');
  });

  test('rejects expired JWE payloads before starting automation', async () => {
    const expired = identityPayload(Date.now() - SENSITIVE_TTL_MS - 1);
    expired.expiresAt = expired.issuedAt + SENSITIVE_TTL_MS;
    const previous = capturedInput;
    const response = await postScenario(expired);
    const body = await response.json();
    expect(response.status).toBe(428);
    expect(body.status).toBe('sensitive_input_expired');
    expect(capturedInput).toBe(previous);
  });
});
