'use strict';

const { test, expect } = require('@playwright/test');
const { runSimulatorCreditCheck } = require('../src/main');
const { SENSITIVE_TTL_MS } = require('../src/sensitiveInput');

function visibleLocator(state = {}) {
  const locator = {
    first() { return this; },
    async count() { return state.count ?? 1; },
    async waitFor(options) { expect(options.state).toBe('visible'); if (state.waitFor) await state.waitFor(); },
    async isEnabled() { return state.enabled !== false; },
    async click() { if (state.click) await state.click(); },
    async fill(value) { state.value = value; },
    async inputValue() { return state.value || ''; },
    async innerText() { return state.innerText ? state.innerText() : (state.text || ''); }
  };
  Object.defineProperty(locator, 'value', { get: () => state.value });
  return locator;
}

function makeCheckoutFrame({ statusText = 'Credit Check Status: APPROVED — no pre-payment required.' } = {}) {
  const state = { clicked: false };
  const ssn = visibleLocator();
  const dob = visibleLocator();
  const creditButton = visibleLocator({ click: async () => { state.clicked = true; } });
  const status = visibleLocator({
    waitFor: async () => { if (!state.clicked) throw new Error('Credit check has not been run.'); },
    innerText: () => statusText
  });
  return {
    state,
    ssn,
    dob,
    locator(selector) {
      if (selector.includes('Run Credit Check')) return creditButton;
      throw new Error(`Unexpected locator: ${selector}`);
    },
    getByLabel(label) {
      if (label === 'Social Security Number') return ssn;
      if (label === 'Date of Birth') return dob;
      throw new Error(`Unexpected label: ${label}`);
    },
    getByText() { return status; }
  };
}

function makeInput(ezEnroll, overrides = {}) {
  const now = Date.now();
  return {
    accountHolder: { ezEnroll },
    sensitiveData: {
      version: 1,
      issuedAt: now,
      expiresAt: now + SENSITIVE_TTL_MS,
      scenario: 'credit-check-identity',
      identity: { ssn: '123456789', dob: '01/02/1990' },
      ...overrides
    }
  };
}

test('EZ-Enroll Yes skips the credit-check identity fields', async () => {
  const frame = {
    locator: () => ({ first: () => ({ waitFor: async () => {} }), count: async () => 2 }),
    getByText: () => ({ waitFor: async () => {} })
  };
  const result = await runSimulatorCreditCheck(frame, { accountHolder: { ezEnroll: true } });
  expect(result).toEqual({
    performed: false,
    approved: null,
    status: 'not_required_ez_enroll',
    dataSource: 'not_required_ez_enroll'
  });
});

test('EZ-Enroll No fills SSN and DOB from the JWE-decoded payload and verifies approval', async () => {
  const frame = makeCheckoutFrame();
  const result = await runSimulatorCreditCheck(frame, makeInput(false));
  expect(result.performed).toBe(true);
  expect(result.approved).toBe(true);
  expect(result.status).toBe('APPROVED');
  expect(frame.ssn.value).toBe('123456789');
  expect(frame.dob.value).toBe('01/02/1990');
  expect(frame.state.clicked).toBe(true);
});

test('expired identity payload requests a fresh encrypted input payload', async () => {
  const frame = makeCheckoutFrame();
  const expired = makeInput(false);
  expired.sensitiveData.expiresAt = Date.now() - 1;
  let refreshCount = 0;
  expired.requestSensitiveRefresh = async () => {
    refreshCount += 1;
    const now = Date.now();
    return {
      version: 1,
      issuedAt: now,
      expiresAt: now + SENSITIVE_TTL_MS,
      scenario: 'credit-check-identity',
      identity: { ssn: '987654321', dob: '02/03/1991' }
    };
  };
  const result = await runSimulatorCreditCheck(frame, expired);
  expect(result.approved).toBe(true);
  expect(refreshCount).toBe(1);
  expect(frame.ssn.value).toBe('987654321');
  expect(frame.dob.value).toBe('02/03/1991');
});
