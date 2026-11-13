
'use strict';

const crypto = require('crypto');
const { test, expect } = require('@playwright/test');

const {
  runSimulatorCreditCheck,
  getCreditCheckStageForError
} = require('../src/main');

const sensitiveDataService = require('../src/sensitiveDataService');

const {
  withIsolatedSensitiveDataStore
} = require('./helpers/isolated-sensitive-data');


function visibleLocator(state = {}) {
  const locator = {
    first() {
      return this;
    },

    async count() {
      return state.count ?? 1;
    },

    async waitFor(options) {
      expect(options.state).toBe('visible');

      if (state.waitFor) {
        await state.waitFor();
      }
    },

    async isEnabled() {
      return state.enabled !== false;
    },

    async click() {
      if (state.click) {
        await state.click();
      }
    },

    async fill(value) {
      state.value = value;
    },

    async inputValue() {
      return state.value || '';
    },

    async innerText() {
      if (state.innerText) {
        return state.innerText();
      }

      return state.text || '';
    }
  };

  Object.defineProperty(locator, 'value', {
    get: () => state.value
  });

  return locator;
}


function makeCheckoutFrame({
  statusText = 'Credit Check Status: APPROVED — no pre-payment required.',
  creditButtonEnabled = true
} = {}) {
  const state = {
    clicked: false
  };

  const ssn = visibleLocator();
  const dob = visibleLocator();

  const installationOptions = visibleLocator({
    count: 2
  });

  const creditButton = visibleLocator({
    enabled: creditButtonEnabled,

    click: async () => {
      state.clicked = true;
    }
  });

  const status = visibleLocator({
    waitFor: async () => {
      if (!state.clicked) {
        throw new Error('Credit check has not been run.');
      }
    },

    innerText: () => statusText
  });

  return {
    state,
    ssn,
    dob,

    locator(selector) {
      if (selector.includes('name="itype"')) {
        return installationOptions;
      }

      if (selector.includes('Run Credit Check')) {
        return creditButton;
      }

      throw new Error(`Unexpected locator: ${selector}`);
    },

    getByLabel(label) {
      if (label === 'Social Security Number') {
        return ssn;
      }

      if (label === 'Date of Birth') {
        return dob;
      }

      throw new Error(`Unexpected label: ${label}`);
    },

    getByText(text) {
      if (text === 'ORDER QUALIFICATION STATUS') {
        return visibleLocator();
      }

      return status;
    }
  };
}


function makeInput(ezEnroll) {
  return {
    accountHolder: {
      ezEnroll
    },

    identity: {
      ssnRecordId: crypto.randomUUID(),
      dateOfBirthRecordId: crypto.randomUUID()
    }
  };
}


test('EZ-Enroll Yes skips identity access and verifies installation-step transition', async () => {
  const frame = makeCheckoutFrame();

  const forbiddenService = new Proxy({}, {
    get() {
      throw new Error(
        'Sensitive-data service must not be called for EZ-Enroll.'
      );
    }
  });

  const result = await runSimulatorCreditCheck(
    frame,
    { accountHolder: { ezEnroll: true } },
    forbiddenService
  );

  expect(result).toEqual({
    performed: false,
    approved: null,
    status: 'not_required_ez_enroll',
    dataSource: 'not_required_ez_enroll'
  });

  expect(frame.state.clicked).toBe(false);
});


test('EZ-Enroll No authorizes, consumes once, fills portal fields, and verifies its displayed result', async () => {
  const frame = makeCheckoutFrame();

  const accessToken = crypto.randomBytes(32).toString('hex');
  const calls = [];

  const service = {
    authorizeSensitiveDataAccess(token, purpose) {
      calls.push([
        'authorize',
        token === accessToken,
        purpose
      ]);

      return { purpose };
    },

    async inspectSensitiveDataRecord(recordId, purpose) {
      calls.push([
        'inspect',
        recordId,
        purpose
      ]);

      return {
        available: true,
        purpose
      };
    },

    async useSensitiveData(
      recordId,
      purpose,
      authorization,
      consumer
    ) {
      calls.push([
        'consume',
        recordId,
        purpose,
        authorization.purpose
      ]);

      // Opaque test fixtures are deliberately not identity-shaped values.
      return consumer(`fixture-${crypto.randomUUID()}`);
    }
  };

  const input = makeInput(false);

  const result = await runSimulatorCreditCheck(
    frame,
    input,
    service,
    accessToken
  );

  expect(result.performed).toBe(true);
  expect(result.approved).toBe(true);
  expect(result.status).toBe('APPROVED');

  expect(frame.ssn.value).toMatch(/^fixture-/);
  expect(frame.dob.value).toMatch(/^fixture-/);
  expect(frame.state.clicked).toBe(true);

  expect(
    calls.filter(call => call[0] === 'authorize')
  ).toEqual([
    ['authorize', true, 'ssn'],
    ['authorize', true, 'dob']
  ]);

  expect(
    calls.filter(call => call[0] === 'consume')
  ).toHaveLength(2);
});


test('EZ-Enroll No uses fresh encrypted test records through the real sensitive-data service', async () => {
  await withIsolatedSensitiveDataStore(async () => {
    const originalKey = process.env.SENSITIVE_DATA_KEY;
    const originalToken = process.env.SENSITIVE_DATA_ACCESS_TOKEN;

    process.env.SENSITIVE_DATA_KEY =
      crypto.randomBytes(32).toString('base64');

    process.env.SENSITIVE_DATA_ACCESS_TOKEN =
      crypto.randomBytes(32).toString('hex');

    const ssnDigits = [
      crypto.randomInt(1, 9),
      ...Array.from(
        { length: 8 },
        () => crypto.randomInt(0, 10)
      )
    ].join('');

    const dobDate = new Date(
      Date.UTC(1975, 0, 1) +
      crypto.randomInt(0, 25 * 365) * 86400000
    );

    const dobValue =
      `${String(dobDate.getUTCMonth() + 1).padStart(2, '0')}/` +
      `${String(dobDate.getUTCDate()).padStart(2, '0')}/` +
      `${dobDate.getUTCFullYear()}`;

    let ssnRecord;
    let dobRecord;

    try {
      ssnRecord = await sensitiveDataService.saveSensitiveData(
        'ssn',
        ssnDigits
      );

      dobRecord = await sensitiveDataService.saveSensitiveData(
        'dob',
        dobValue
      );

      const frame = makeCheckoutFrame();

      const input = {
        accountHolder: {
          ezEnroll: false
        },

        identity: {
          ssnRecordId: ssnRecord.recordId,
          dateOfBirthRecordId: dobRecord.recordId
        }
      };

      const result = await runSimulatorCreditCheck(
        frame,
        input,
        sensitiveDataService,
        process.env.SENSITIVE_DATA_ACCESS_TOKEN
      );

      expect(result.approved).toBe(true);
      expect(frame.state.clicked).toBe(true);

      expect(
        await sensitiveDataService.inspectSensitiveDataRecord(
          ssnRecord.recordId,
          'ssn'
        )
      ).toEqual({
        available: false,
        purpose: 'ssn'
      });

      expect(
        await sensitiveDataService.inspectSensitiveDataRecord(
          dobRecord.recordId,
          'dob'
        )
      ).toEqual({
        available: false,
        purpose: 'dob'
      });
    } finally {
      if (ssnRecord) {
        await sensitiveDataService
          .deleteSensitiveData(ssnRecord.recordId)
          .catch(() => {});
      }

      if (dobRecord) {
        await sensitiveDataService
          .deleteSensitiveData(dobRecord.recordId)
          .catch(() => {});
      }

      if (originalKey === undefined) {
        delete process.env.SENSITIVE_DATA_KEY;
      } else {
        process.env.SENSITIVE_DATA_KEY = originalKey;
      }

      if (originalToken === undefined) {
        delete process.env.SENSITIVE_DATA_ACCESS_TOKEN;
      } else {
        process.env.SENSITIVE_DATA_ACCESS_TOKEN = originalToken;
      }
    }
  });
});


test('EZ-Enroll No checks both records before consuming either and rejects an unavailable record', async () => {
  const frame = makeCheckoutFrame();

  let consumes = 0;

  const service = {
    authorizeSensitiveDataAccess(_token, purpose) {
      return { purpose };
    },

    async inspectSensitiveDataRecord(_recordId, purpose) {
      return {
        available: purpose === 'ssn',
        purpose
      };
    },

    async useSensitiveData() {
      consumes += 1;
    }
  };

  await expect(
    runSimulatorCreditCheck(
      frame,
      makeInput(false),
      service,
      crypto.randomBytes(32).toString('hex')
    )
  ).rejects.toThrow(/unavailable or already consumed/);

  expect(consumes).toBe(0);
  expect(frame.state.clicked).toBe(false);
});


test('EZ-Enroll No attaches a safe record-preflight stage without consuming unavailable records', async () => {
  const frame = makeCheckoutFrame();

  let consumes = 0;

  const service = {
    authorizeSensitiveDataAccess(_token, purpose) {
      return { purpose };
    },

    async inspectSensitiveDataRecord(_recordId, purpose) {
      return {
        available: purpose !== 'ssn',
        purpose
      };
    },

    async useSensitiveData() {
      consumes += 1;
    }
  };

  let caughtError;

  try {
    await runSimulatorCreditCheck(
      frame,
      makeInput(false),
      service,
      crypto.randomBytes(32).toString('hex')
    );
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);

  expect(
    getCreditCheckStageForError(caughtError)
  ).toBe('record_availability_validation_started');

  expect(consumes).toBe(0);
  expect(frame.state.clicked).toBe(false);
});


test('credit button readiness stage requires the locator to be enabled', async () => {
  const frame = makeCheckoutFrame({
    creditButtonEnabled: false
  });

  const service = {
    authorizeSensitiveDataAccess(_token, purpose) {
      return { purpose };
    },

    async inspectSensitiveDataRecord(_recordId, purpose) {
      return {
        available: true,
        purpose
      };
    },

    async useSensitiveData(
      _recordId,
      _purpose,
      _authorization,
      consumer
    ) {
      return consumer(`fixture-${crypto.randomUUID()}`);
    }
  };

  let caughtError;

  try {
    await runSimulatorCreditCheck(
      frame,
      makeInput(false),
      service,
      crypto.randomBytes(32).toString('hex')
    );
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);

  expect(
    getCreditCheckStageForError(caughtError)
  ).toBe('ssn_fill_completed');

  expect(frame.state.clicked).toBe(false);
});


test('EZ-Enroll No preserves the original frozen error and stores its inspection stage out of band', async () => {
  const frame = makeCheckoutFrame();

  const originalError = Object.freeze(
    new Error('synthetic SSN inspection failure')
  );

  const service = {
    authorizeSensitiveDataAccess(_token, purpose) {
      return { purpose };
    },

    async inspectSensitiveDataRecord(_recordId, purpose) {
      if (purpose === 'ssn') {
        throw originalError;
      }

      throw new Error('DOB inspection must not be reached.');
    },

    async useSensitiveData() {
      throw new Error('Sensitive-data consumption must not be reached.');
    }
  };

  let caughtError;

  try {
    await runSimulatorCreditCheck(
      frame,
      makeInput(false),
      service,
      crypto.randomBytes(32).toString('hex')
    );
  } catch (error) {
    caughtError = error;
  }

  // The exact original error must survive without mutation or replacement.
  expect(caughtError).toBe(originalError);
  expect(caughtError.message).toBe('synthetic SSN inspection failure');
  expect(caughtError).not.toHaveProperty('creditCheckStage');

  // The diagnostic stage is stored separately from the error object.
  expect(
    getCreditCheckStageForError(caughtError)
  ).toBe('ssn_record_inspection_started');

  expect(frame.state.clicked).toBe(false);
});


test('EZ-Enroll No stops when the portal displays a non-approved result', async () => {
  const frame = makeCheckoutFrame({
    statusText: 'Credit Check Status: REVIEW — manual follow-up required.'
  });

  const service = {
    authorizeSensitiveDataAccess(_token, purpose) {
      return { purpose };
    },

    async inspectSensitiveDataRecord(_recordId, purpose) {
      return {
        available: true,
        purpose
      };
    },

    async useSensitiveData(
      _recordId,
      _purpose,
      _authorization,
      consumer
    ) {
      return consumer(`fixture-${crypto.randomUUID()}`);
    }
  };

  await expect(
    runSimulatorCreditCheck(
      frame,
      makeInput(false),
      service,
      crypto.randomBytes(32).toString('hex')
    )
  ).rejects.toThrow(/did not return an approval/);

  expect(frame.state.clicked).toBe(true);
});
