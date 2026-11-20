'use strict';

const readline = require('readline');
const SENSITIVE_TTL_MS = 7 * 60 * 1000;
function inputError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.failureStage = 'sensitive_input';
  return error;
}

const TEST_CARD_NUMBERS = new Set([
  '4242424242424242',
  '4111111111111111'
]);

function readMasked(prompt, options = {}) {
  const { allowEmpty = false } = options;
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Sensitive input requires an interactive terminal.'));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    process.stdout.write(prompt);

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };

    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Sensitive input cancelled.'));
        return;
      }
      if (key.name === 'return' || character === '\r' || character === '\n') {
        cleanup();
        if (!allowEmpty && value.length === 0) {
          reject(new Error('A value is required.'));
          return;
        }
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (character && character.length === 1 && !key.ctrl && !key.meta) {
        value += character;
        process.stdout.write('*');
      }
    };
    process.stdin.on('keypress', onKeypress);
  });
}

function validateDob(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ''));
  if (!match) throw inputError('DOB must use MM/DD/YYYY format.', 'DOB_FORMAT_INVALID');

  const [, mm, dd, yyyy] = match;
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);

  // Use UTC setters rather than the multi-argument Date constructor. The
  // constructor treats years 00-99 as 1900-1999, which is not a strict
  // calendar round-trip and can misclassify four-digit years.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw inputError('DOB is not a valid calendar date.', 'DOB_DATE_INVALID');
  }
}

async function readValidDob(log = console.log, reader = readMasked) {
  while (true) {
    const dob = await reader('Enter synthetic DOB (MM/DD/YYYY, e.g. 01/02/1990): ');
    try {
      validateDob(dob);
      return dob;
    } catch (error) {
      if (!['DOB_FORMAT_INVALID', 'DOB_DATE_INVALID'].includes(error.code)) {
        throw error;
      }
      log(`${error.message} Please enter the DOB again.`);
    }
  }
}

function luhnValid(value) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

async function promptSensitivePayload(order, log = console.log) {
  const payload = {
    version: 1,
    scenario: order.accountHolder.ezEnroll ? 'ez-enroll-card' : 'credit-check-identity'
  };

  if (order.accountHolder.ezEnroll === false) {
    log('\nSENSITIVE IDENTITY INPUT (masked; synthetic demo values only)');
    const ssn = await readMasked('Enter synthetic SSN (9 digits): ');
    if (!/^\d{9}$/.test(ssn)) throw inputError('SSN must contain exactly 9 digits.', 'SSN_FORMAT_INVALID');
    const dob = await readValidDob(log);
    payload.identity = { ssn, dob };
  } else {
    log('\nDEMO PAYMENT INPUT (masked; use simulator test-card values only)');
    const cardHolderName = await readMasked('Enter test card holder name: ');
    const cardNumber = (await readMasked('Enter simulator test card number: ')).replace(/[ -]/g, '');
    if (!/^\d{13,19}$/.test(cardNumber) || !luhnValid(cardNumber) || !TEST_CARD_NUMBERS.has(cardNumber)) {
      throw inputError('Use a supported synthetic test card number (4242424242424242 or 4111111111111111).', 'TEST_CARD_UNSUPPORTED');
    }
    const expirationMonth = await readMasked('Enter expiry month (MM): ');
    const expirationYear = await readMasked('Enter expiry year (YYYY): ');
    const cvv = await readMasked('Enter test CVV (3 or 4 digits): ');
    const month = Number(expirationMonth);
    const year = Number(expirationYear);
    const now = new Date();
    if (!/^\d{2}$/.test(expirationMonth) || month < 1 || month > 12 || !/^20\d{2}$/.test(expirationYear)) {
      throw inputError('Expiry must use a valid MM and YYYY.', 'EXPIRY_FORMAT_INVALID');
    }
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
      throw inputError('Test card expiry must be in the future.', 'TEST_CARD_EXPIRED');
    }
    if (!/^\d{3,4}$/.test(cvv)) throw inputError('CVV must contain 3 or 4 digits.', 'CVV_FORMAT_INVALID');
    payload.payment = { cardHolderName, cardNumber, expirationMonth, expirationYear, cvv };
  }

  // Start the seven-minute clock only after the final field has been entered.
  payload.issuedAt = Date.now();
  payload.expiresAt = payload.issuedAt + SENSITIVE_TTL_MS;
  return payload;
}

function validateSensitivePayload(payload, order, now = Date.now()) {
  if (!payload || payload.version !== 1 || !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) {
    throw inputError('Sensitive JWE payload is invalid.', 'SENSITIVE_PAYLOAD_INVALID');
  }
  if (payload.expiresAt - payload.issuedAt !== SENSITIVE_TTL_MS) {
    throw inputError('Sensitive input validity must be exactly seven minutes.', 'SENSITIVE_TTL_INVALID');
  }
  if (payload.issuedAt > now + 30000 || now >= payload.expiresAt) {
    const error = new Error('Sensitive input expired. Please enter the required details again.');
    error.code = 'SENSITIVE_INPUT_EXPIRED';
    throw error;
  }
  if (order.accountHolder.ezEnroll === false) {
    if (payload.scenario !== 'credit-check-identity' || !payload.identity || !/^\d{9}$/.test(payload.identity.ssn || '')) {
      throw inputError('Encrypted identity payload is incomplete.', 'IDENTITY_PAYLOAD_INCOMPLETE');
    }
    validateDob(payload.identity.dob || '');
  } else {
    if (payload.scenario !== 'ez-enroll-card' || !payload.payment) throw inputError('Encrypted payment payload is incomplete.', 'PAYMENT_PAYLOAD_INCOMPLETE');
    const card = payload.payment;
    const number = String(card.cardNumber || '');
    if (!TEST_CARD_NUMBERS.has(number) || !luhnValid(number)) throw inputError('Only supported synthetic test-card numbers are accepted.', 'TEST_CARD_UNSUPPORTED');
    const month = Number(card.expirationMonth);
    const year = Number(card.expirationYear);
    const current = new Date(now);
    if (!String(card.cardHolderName || '').trim() || !/^\d{2}$/.test(card.expirationMonth || '') || month < 1 || month > 12 || !/^20\d{2}$/.test(card.expirationYear || '') || !/^\d{3,4}$/.test(card.cvv || '')) {
      throw inputError('Encrypted payment payload is incomplete.', 'PAYMENT_PAYLOAD_INCOMPLETE');
    }
    if (year < current.getFullYear() || (year === current.getFullYear() && month < current.getMonth() + 1)) {
      throw inputError('Simulator test-card expiry must be in the future.', 'TEST_CARD_EXPIRED');
    }
  }
  return true;
}

function makeSensitivePayload(order, values, now = Date.now()) {
  const payload = {
    ...values,
    issuedAt: now,
    expiresAt: now + SENSITIVE_TTL_MS,
    version: 1,
    scenario: order.accountHolder.ezEnroll ? 'ez-enroll-card' : 'credit-check-identity'
  };
  return payload;
}

function isSensitivePayloadFresh(payload, now = Date.now()) {
  return Boolean(payload && Number.isFinite(payload.expiresAt) && now < payload.expiresAt);
}

function zeroSensitivePayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  for (const section of ['identity', 'payment']) {
    if (payload[section] && typeof payload[section] === 'object') {
      for (const key of Object.keys(payload[section])) payload[section][key] = '';
    }
  }
}

module.exports = {
  SENSITIVE_TTL_MS,
  validateDob,
  readValidDob,
  promptSensitivePayload,
  validateSensitivePayload,
  makeSensitivePayload,
  isSensitivePayloadFresh,
  zeroSensitivePayload
};
