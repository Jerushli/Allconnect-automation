
const { test, expect } = require('@playwright/test');

const {
  classifyError,
  inspectBrowserState,
  withBoundedRetry,
  navigateWithRecovery,
  captureFailureDiagnostics
} = require('../src/recovery');

const { sanitizeExecutionReport } = require('../src/main');


test('bounded recovery retries a transient read-only wait and returns verified completion', async () => {
  let calls = 0;
  let inspections = 0;

  const result = await withBoundedRetry(async () => {
    calls += 1;

    if (calls < 2) {
      throw new Error('Timeout waiting for locator');
    }

    return 'visible';
  }, {
    retryable: true,
    attempts: 3,
    initialDelayMs: 1,
    maxDelayMs: 2,
    inspect: async () => {
      inspections += 1;
    }
  });

  expect(result).toBe('visible');
  expect(calls).toBe(2);
  expect(inspections).toBe(1);
});


test('recovery stops after the configured retry limit', async () => {
  let calls = 0;

  await expect(withBoundedRetry(async () => {
    calls += 1;
    throw new Error('Timeout waiting for locator');
  }, {
    retryable: true,
    attempts: 2,
    initialDelayMs: 1,
    maxDelayMs: 1
  })).rejects.toThrow('Timeout');

  expect(calls).toBe(2);
});


test('side-effect operations are one-shot unless explicitly declared safe', async () => {
  let calls = 0;

  await expect(withBoundedRetry(async () => {
    calls += 1;
    throw new Error('credit check failed');
  }, {
    retryable: false,
    attempts: 3
  })).rejects.toThrow('credit check failed');

  expect(calls).toBe(1);
});


test('failure classifier distinguishes validation, locator, auth, and browser failures', () => {
  expect(
    classifyError(new Error('Missing required customer field: city')).type
  ).toBe('input_validation');

  expect(
    classifyError(new Error('strict mode violation: resolved to 2 elements')).type
  ).toBe('strict_locator');

  expect(
    classifyError(new Error('Unauthorized API token')).type
  ).toBe('authentication');

  expect(
    classifyError(new Error('Browser has been closed')).type
  ).toBe('browser_disconnected');

  expect(
    classifyError(new Error('Form validation error: invalid address field')).type
  ).toBe('form_validation');

  expect(
    classifyError(new Error('Unexpected page transition')).type
  ).toBe('unexpected_transition');

  expect(
    classifyError(Object.assign(new Error('Use a supported synthetic test card number.'), { code: 'TEST_CARD_UNSUPPORTED' })).type
  ).toBe('input_validation');

  expect(
    classifyError(Object.assign(new Error('DOB is not a valid calendar date.'), { code: 'DOB_DATE_INVALID' })).type
  ).toBe('input_validation');
});


test('failure classification preserves only allowlisted workflow and credit-check stages', () => {
  const rawSentinel = 'PRIVATE_FAILURE_SENTINEL';

  const classified = classifyError(
    new Error(`failure ${rawSentinel}`),
    {
      step: 'Demo Credit Check, Installation and Payment',
      creditCheckStage: 'credit_button_click_started'
    }
  );

  expect(classified.step).toBe(
    'Demo Credit Check, Installation and Payment'
  );

  expect(classified.creditCheckStage).toBe(
    'credit_button_click_started'
  );

  expect(classified.type).toBe('credit_check');

  expect(JSON.stringify(classified)).not.toContain(rawSentinel);

  const rejected = classifyError(new Error('failure'), {
    step: 'Customer PII step',
    creditCheckStage: 'ssn-value-was-here'
  });

  expect(rejected).not.toHaveProperty('step');
  expect(rejected).not.toHaveProperty('creditCheckStage');
  expect(rejected.type).toBe('automation');
});


test('failure classification preserves each approved credit-check diagnostic stage', () => {
  const stages = [
    'record_preflight',

    'ssn_authorization_started',
    'ssn_authorization_completed',
    'dob_authorization_started',
    'dob_authorization_completed',

    'ssn_record_inspection_started',
    'ssn_record_inspection_completed',
    'dob_record_inspection_started',
    'dob_record_inspection_completed',

    'ssn_field_wait_started',
    'ssn_field_ready',
    'dob_field_wait_started',
    'dob_field_ready',

    'ssn_fill_started',
    'ssn_fill_completed',
    'ssn_value_verification_started',
    'ssn_value_verified',

    'credit_button_ready',

    'dob_fill_started',
    'dob_fill_completed',
    'dob_value_verification_started',
    'dob_value_verified',

    'credit_button_click_started',
    'credit_button_click_completed',

    'credit_result_wait_started',
    'credit_result_received',
    'credit_result_read_started',
    'credit_result_read_completed',
    'credit_result_validation_started',
    'credit_result_validation_completed'
  ];

  for (const stage of stages) {
    const result = classifyError(
      new Error('A generic simulator operation failed'),
      { creditCheckStage: stage }
    );

    expect(
  result.type,
  `Unexpected classification for stage: ${stage}`
).toBe('credit_check');
    expect(result.creditCheckStage).toBe(stage);
  }
});


test('a valid credit-check stage classifies a generic error as a credit-check failure', () => {
  const result = classifyError(
    new Error('A generic simulator operation failed'),
    {
      step: 'Demo Credit Check, Installation and Payment',
      creditCheckStage: 'dob_fill_started'
    }
  );

  expect(result).toEqual({
    type: 'credit_check',
    recoverable: false,
    step: 'Demo Credit Check, Installation and Payment',
    creditCheckStage: 'dob_fill_started'
  });
});


test('failure classification rejects unapproved credit-check stage names', () => {
  const unsafeStages = [
    'customer_ssn_value',
    'dob_1990_01_01',
    '123456789',
    'private-record-id',
    'unknown_internal_operation'
  ];

  for (const stage of unsafeStages) {
    const result = classifyError(
      new Error('A generic simulator operation failed'),
      { creditCheckStage: stage }
    );

    expect(result).not.toHaveProperty('creditCheckStage');
    expect(result.type).not.toBe('credit_check');
  }
});


test('an invalid credit-check stage does not classify a generic error as a credit-check failure', () => {
  const result = classifyError(
    new Error('A generic simulator operation failed'),
    {
      creditCheckStage: 'customer_ssn_value'
    }
  );

  expect(result.type).toBe('simulator');
  expect(result.type).not.toBe('credit_check');
  expect(result.creditCheckStage).toBeUndefined();
});


test('failure diagnostics carry allowlisted stages through report sanitization with a mocked page', async () => {
  const safePage = {
    isClosed: () => false,
    url: () => 'https://portal.test/allconnect-frame/checkout/',
    title: async () => 'Simulator',
    evaluate: async () => ({
      readyState: 'complete',
      headings: ['Simulator'],
      visibleFormCount: 0,
      iframeCount: 1
    })
  };

  const rawSentinel = 'PRIVATE_RAW_ERROR_SENTINEL';

  const diagnostics = await captureFailureDiagnostics(
    safePage,
    new Error(rawSentinel),
    {
      step: 'Demo Credit Check, Installation and Payment',
      creditCheckStage: 'credit_button_ready'
    }
  );

  const report = sanitizeExecutionReport({
    error: diagnostics
  });

  expect(report.error.failure.step).toBe(
    'Demo Credit Check, Installation and Payment'
  );

  expect(report.error.failure.creditCheckStage).toBe(
    'credit_button_ready'
  );

  expect(report.error.failure.type).toBe('credit_check');

  expect(JSON.stringify(report)).not.toContain(rawSentinel);
});


test('browser inspection reports page state without reading form values', async ({ page }) => {
  await page.setContent(
    '<h1>Installation</h1><form><input name="identity" value="do-not-read"></form>'
  );

  const state = await inspectBrowserState(page);

  expect(state.connected).toBe(true);
  expect(state.readyState).toBe('complete');
  expect(state.headings).toContain('Installation');
  expect(JSON.stringify(state)).not.toContain('do-not-read');
});


test('navigation recovery verifies the destination and does not reload an already reached page', async ({ page }) => {
  let requests = 0;

  await page.route('http://recovery.test/portal', async route => {
    requests += 1;

    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Portal</h1>'
    });
  });

  const first = await navigateWithRecovery(
    page,
    'http://recovery.test/portal',
    { timeout: 1000 }
  );

  const second = await navigateWithRecovery(
    page,
    'http://recovery.test/portal',
    { timeout: 1000 }
  );

  expect(first.url).toBe('http://recovery.test/[redacted-path]');
  expect(second.alreadyReached).toBe(true);
  expect(requests).toBe(1);
});


test('failure diagnostics omit screenshots and raw exception text', async ({ page }) => {
  await page.setContent(
    '<h1>Simulator</h1><input value="sensitive-test-value"><iframe id="checkoutContent" srcdoc="&lt;input value=&quot;iframe-test-value&quot;&gt;"></iframe>'
  );

  const diagnostics = await captureFailureDiagnostics(
    page,
    new Error('locator failed with sensitive-test-value'),
    {
      step: 'Simulator Test'
    }
  );

  expect(diagnostics.screenshotOmitted).toBe(
    'disabled_to_prevent_sensitive_capture'
  );

  expect(diagnostics.failure.type).toBe('element_not_found');
  expect(diagnostics.failure.step).toBeUndefined();

  expect(JSON.stringify(diagnostics)).not.toContain(
    'sensitive-test-value'
  );

  expect(JSON.stringify(diagnostics)).not.toContain(
    'iframe-test-value'
  );
});
