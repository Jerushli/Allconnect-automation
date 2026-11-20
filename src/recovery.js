'use strict';

const {
  sanitizeDiagnosticUrl,
  safeDiagnosticLabel
} = require('./diagnostics');

const DEFAULT_RETRY = Object.freeze({
  attempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 1000
});

const SAFE_WORKFLOW_STEPS = new Set([
  'Portal Login',
  'Basic Information',
  'Customer Qualification',
  'Address Validation',
  'Recommendations',
  'Internet Category',
  'Internet Offers',
  'Plan Selection',
  'Open Plan Details',
  'Plan Verification',
  'Add Plan to Order',
  'Cart Verification',
  'Open Checkout',
  'Checkout Inspection',
  'Product Customization Inspection',
  'Apply Customizations',
  'Advance to Product Customization',
  'Account Holder Validation',
  'Account Holder Forward',
  'Demo Credit Check, Installation and Payment'
]);

const SAFE_CREDIT_CHECK_STAGES = new Set([
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
  'credit_result_validation_completed',

  'record_availability_validation_started'
]);

function isSafeWorkflowStep(value) {
  return typeof value === 'string' && SAFE_WORKFLOW_STEPS.has(value);
}

function isSafeCreditCheckStage(value) {
  return typeof value === 'string' && SAFE_CREDIT_CHECK_STAGES.has(value);
}

const SAFE_FIELD_LABELS = new Set([
  'Name Prefix', 'First Name', 'Last Name', 'ZIP Code', 'Service Address',
  'Unit Number', 'City', 'State', 'Service Address Type', 'Unit Type',
  'Rent or Own', 'Customer Moving Option', 'Moving Date', 'Call ID',
  'Contact Phone', 'Email Address', 'SSN', 'Date of Birth', 'Install Date',
  'Preferred Time', 'Card Type', 'Card Number', 'Card Holder Name',
  'CVV Code', 'Expiration Month', 'Expiration Year'
]);

const SAFE_FIELD_FAILURE_MESSAGES = new Set([
  'The ZIP Code format is invalid.',
  'The ZIP Code is required.',
  'The portal marked the ZIP Code as invalid or unsupported.',
  'The portal did not enable the address fields after ZIP Code entry. Verify that the ZIP Code is accepted by the portal.'
]);

function sanitizeFieldFailure(details) {
  if (!details || details.type !== 'field_validation') return undefined;
  const step = isSafeWorkflowStep(details.step) ? details.step : undefined;
  const field = SAFE_FIELD_LABELS.has(details.field) ? details.field : undefined;
  const message = SAFE_FIELD_FAILURE_MESSAGES.has(details.message)
    ? details.message
    : typeof details.message === 'string' && /^Could not (enter|select) (Name Prefix|First Name|Last Name|ZIP Code|Service Address|Unit Number|City|State|Service Address Type|Unit Type|Rent or Own|Customer Moving Option|Moving Date|Call ID|Contact Phone|Email Address|SSN|Date of Birth|Install Date|Preferred Time|Card Type|Card Number|Card Holder Name|CVV Code|Expiration Month|Expiration Year)\. Check that the (field is available and accepts the supplied input|requested option is available)\.$/.test(details.message)
      ? details.message
      : field && details.message === `The entered ${field} could not be verified.`
        ? details.message
        : undefined;
  if (!step || !field || !message) return undefined;
  return { type: 'field_validation', step, field, message };
}


function classifyError(error, context = {}) {
  const message = String(error?.message || error || 'Unknown error');
  const text = `${String(error?.name || 'Error')} ${message}`.toLowerCase();
  let type = 'automation';
  const fieldFailure = sanitizeFieldFailure(error?.failureDetails);
  if (fieldFailure) type = 'form_validation';

  if (/unauthorized|authentication|password missing|401|forbidden/.test(text)) {
    type = 'authentication';
  } else if (/^(SSN_|DOB_|CVV_|EXPIRY_|TEST_CARD_|SENSITIVE_|IDENTITY_PAYLOAD_|PAYMENT_PAYLOAD_)/.test(String(error?.code || '')) || /synthetic test.card|ssn must|dob must|dob is not|cvv must|expiry must|test.card expiry|sensitive jwe payload|encrypted identity payload|encrypted payment payload/i.test(message)) {
    type = 'input_validation';
  } else if (/form validation|validation error|please .*required|invalid .*field/.test(text)) {
    type = 'form_validation';
  } else if (/missing|required|invalid scenario|must be|unsupported value/.test(text)) {
    type = 'input_validation';
  } else if (
    /credit check|credit-check/.test(text) ||
    isSafeCreditCheckStage(context.creditCheckStage)
  ) {
    type = 'credit_check';
  } else if (/installation/.test(text)) {
    type = 'installation_selection';
  } else if (/api|http|request failed|status code/.test(text)) {
    type = 'api';
  } else if (/strict mode|strict locator|resolved to \d+ elements/.test(text)) {
    type = 'strict_locator';
  } else if (/not visible|hidden|not enabled|disabled/.test(text)) {
    type = 'element_state';
  } else if (/no element|not found|waiting for locator|timeout.*locator|locator failed/.test(text)) {
    type = 'element_not_found';
  } else if (/iframe|frame/.test(text)) {
    type = 'iframe_loading';
  } else if (/validation|invalid|please .*required|error.*form/.test(text)) {
    type = 'form_validation';
  } else if (/target closed|browser has been closed|disconnected|crash|page closed/.test(text)) {
    type = 'browser_disconnected';
  } else if (/navigation|net::|goto|page load|timeout/.test(text)) {
    type = 'navigation_or_load';
  } else if (/simulator/.test(text)) {
    type = 'simulator';
  } else if (/unexpected page|unexpected transition|wrong page state/.test(text)) {
    type = 'unexpected_transition';
  }

  // A verified field-level diagnostic takes precedence over broader categories
  // such as credit_check when the failed action was a field entry.
  if (fieldFailure) type = 'form_validation';

  // Do not persist raw exception text: browser/library errors can echo input values.
  return {
    type,
    recoverable: context.recoverable === true,
    ...(fieldFailure ? { fieldFailure } : {}),
    ...(fieldFailure ? { step: fieldFailure.step } : isSafeWorkflowStep(context.step) ? { step: context.step } : {}),
    ...(isSafeCreditCheckStage(context.creditCheckStage)
      ? { creditCheckStage: context.creditCheckStage }
      : {})
  };
}

async function inspectBrowserState(page) {
  const state = { connected: false, url: null, title: null, readyState: null, headings: [], visibleFormCount: 0, iframeCount: null };
  if (!page) return state;
  try {
    state.connected = !page.isClosed();
    if (!state.connected) return state;
    state.url = sanitizeDiagnosticUrl(page.url());
    const title = await page.title().catch(() => null);
    state.title = safeDiagnosticLabel(title);
    const details = await page.evaluate(() => ({
      readyState: document.readyState,
      headings: Array.from(document.querySelectorAll('h1,h2')).filter(el => el.getClientRects().length).slice(0, 8).map(el => (el.innerText || '').trim().slice(0, 120)),
      visibleFormCount: Array.from(document.forms).filter(el => el.getClientRects().length).length,
      iframeCount: document.querySelectorAll('iframe').length
    }));
    details.headings = details.headings.map(safeDiagnosticLabel);
    Object.assign(state, details);
  } catch (error) {
    state.inspectionError = classifyError(error).type;
  }
  return state;
}

async function withBoundedRetry(operation, options = {}) {
  const { attempts, initialDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...options };
  // By default an operation is not replayable. Callers must explicitly mark
  // a read-only wait as retryable; actions and sensitive-data calls stay one-shot.
  if (options.retryable !== true) return operation(1);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || (options.shouldRetry && !(await options.shouldRetry(error, attempt)))) throw error;
      if (options.inspect) await options.inspect(attempt, error);
      const delay = Math.min(initialDelayMs * (2 ** (attempt - 1)), maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function navigateWithRecovery(page, url, options = {}) {
  const expectedUrl = new URL(url).href;
  const isExpectedPageReady = async () => {
    if (!page || page.isClosed()) return false;
    try {
      const current = new URL(page.url());
      const expected = new URL(expectedUrl);
      // The portal legitimately redirects its entry path to the simulator's
      // root/login URL (often adding a `next` query). Stay on the configured
      // origin, then let the login's own specific control wait verify the page.
      if (current.origin !== expected.origin) return false;
      const readyState = await page.evaluate(() => document.readyState);
      return readyState === 'interactive' || readyState === 'complete';
    } catch {
      return false;
    }
  };

  return withBoundedRetry(async () => {
    if (await isExpectedPageReady()) return { alreadyReached: true, url: sanitizeDiagnosticUrl(page.url()) };
    try {
      await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout || 30000 });
    } catch (error) {
      // A navigation timeout can occur after the destination committed.
      // Verify that state before considering another GET attempt.
      if (await isExpectedPageReady()) return { alreadyReached: true, url: sanitizeDiagnosticUrl(page.url()) };
      throw error;
    }
    if (!(await isExpectedPageReady())) throw new Error('Unexpected page transition after portal navigation.');
    return { alreadyReached: false, url: sanitizeDiagnosticUrl(page.url()) };
  }, {
    retryable: true,
    attempts: options.attempts || 2,
    initialDelayMs: options.initialDelayMs || 500,
    maxDelayMs: options.maxDelayMs || 1500,
    inspect: async () => {
      if (page.isClosed()) throw new Error('Browser page closed during portal navigation.');
      await inspectBrowserState(page);
    }
  });
}

async function captureFailureDiagnostics(page, error, options = {}) {
  const diagnostics = {
    failure: classifyError(error, options),
    browser: await inspectBrowserState(page),
    capturedAt: new Date().toISOString()
  };
  diagnostics.screenshotOmitted = 'disabled_to_prevent_sensitive_capture';
  return diagnostics;
}

module.exports = {
  classifyError,
  isSafeWorkflowStep,
  isSafeCreditCheckStage,
  inspectBrowserState,
  withBoundedRetry,
  navigateWithRecovery,
  captureFailureDiagnostics
};
