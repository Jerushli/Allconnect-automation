
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getConfig } = require('./config');
const { launchBrowser } = require('./browser');
const { login } = require('./auth');
const {
  captureRedactedScreenshot,
  sanitizeDiagnosticUrl,
  safeDiagnosticLabel,
  redactDiagnosticText
} = require('./diagnostics');
const {
  classifyError,
  isSafeWorkflowStep,
  isSafeCreditCheckStage,
  captureFailureDiagnostics,
  inspectBrowserState,
  withBoundedRetry,
  navigateWithRecovery
} = require('./recovery');

const {
  inspectBasicInformation,
  fillBasicInformation
} = require('./basicInformation');
const diagnosticInspectionsEnabled =
  process.env.AUTOMATION_DIAGNOSTICS === 'true';
const { validateSensitivePayload, isSensitivePayloadFresh, zeroSensitivePayload } = require('./sensitiveInput');
const checkoutFrameCache = new WeakMap();
const creditCheckFailureStages = new WeakMap();

function getCreditCheckStageForError(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }
  return creditCheckFailureStages.get(error);
}

function sanitizeExecutionReport(report) {
  const sensitiveKeys = /^(customer|customerName|contact|identity|firstName|middleInitial|lastName|fullName|phone|email|ssn|dob|dateOfBirth|password|token|apiToken|accessToken|sensitiveDataAccessToken|secret|authorization|cardNumber|cardHolderName|cardholder|cvv|expirationMonth|expirationYear|expiry|address|unitNumber|city|zipCode|callId|moveInDate|installDate|orderNumber|value|valueAttribute|inputValue|fieldValue|bodyText|pageText|stack|message|requested|observed|selected|selectedOption|formAction|formId|href|autocomplete|screenshotPath|path|validationMessage)$/i;
  const safeActionText = new Set(['Forward >', 'Forward', 'Run Credit Check', 'Confirm Installation >']);

  function visit(value, key = '') {
    if (key === 'step') return isSafeWorkflowStep(value) ? value : '[redacted]';
    if (key === 'fieldFailure') {
      const failure = value && typeof value === 'object' ? value : {};
      const safeSteps = new Set([
        'Basic Information', 'Account Holder Validation',
        'Demo Credit Check, Installation and Payment'
      ]);
      const safeFields = new Set([
        'Name Prefix', 'First Name', 'Last Name', 'ZIP Code', 'Service Address',
        'Unit Number', 'City', 'State', 'Service Address Type', 'Unit Type',
        'Rent or Own', 'Customer Moving Option', 'Moving Date', 'Call ID',
        'Contact Phone', 'Email Address', 'SSN', 'Date of Birth', 'Install Date',
        'Preferred Time', 'Card Type', 'Card Number', 'Card Holder Name',
        'CVV Code', 'Expiration Month', 'Expiration Year'
      ]);
      const safeMessage = typeof failure.message === 'string' && (
        /^Could not (enter|select) /.test(failure.message) ||
        /^The entered .+ could not be verified\.$/.test(failure.message) ||
        failure.message === 'The ZIP Code format is invalid.' ||
        failure.message === 'The ZIP Code is required.' ||
        failure.message === 'The portal marked the ZIP Code as invalid or unsupported.' ||
        failure.message === 'The portal did not enable the address fields after ZIP Code entry. Verify that the ZIP Code is accepted by the portal.'
      ) ? failure.message : 'The form field could not be completed.';
      return {
        type: 'field_validation',
        ...(safeSteps.has(failure.step) ? { step: failure.step } : {}),
        ...(safeFields.has(failure.field) ? { field: failure.field } : {}),
        message: safeMessage
      };
    }
    if (key === 'creditCheckStage') {
      return isSafeCreditCheckStage(value) ? value : '[redacted]';
    }
    if (typeof value === 'string') {
      if (key === 'error') return '[redacted]';
      if (sensitiveKeys.test(key)) return '[redacted]';
      if (key === 'url') return sanitizeDiagnosticUrl(value);
      if (key === 'title') return safeDiagnosticLabel(value);
      if (key === 'headings') return safeDiagnosticLabel(value);
      if (key === 'text') return safeActionText.has(value.trim()) ? value.trim() : '[redacted]';
      if (key === 'label' || key === 'placeholder' || key === 'ariaLabel' || key === 'id' || key === 'name') return '[redacted]';
      return redactDiagnosticText(value);
    }
    if (Array.isArray(value)) {
      if (key === 'routeResponses') {
  return value.map(item => ({
    path: [
      '/allconnect-frame/order-summary',
      '/allconnect-frame/order-summary/'
    ].includes(item?.path)
      ? item.path
      : '[redacted]',
    status: Number.isInteger(item?.status) &&
      item.status >= 100 &&
      item.status <= 599
        ? item.status
        : '[redacted]'
  }));
}
      if (key === 'controls') {
        const allowed = new Set([
  'tag',
  'type',
  'text',
  'disabled',
  'required',
  'insideForm',
  'formDetails',
  'formActionPresent',
  'formMethod',
  'formNoValidate',
  'onclickPresent',
  'inlineOnclickPresent',
  'checked',
  'ariaInvalid',
  'valid'
]);
        return value.map(control => Object.fromEntries(Object.entries(control || {})
          .filter(([field]) => allowed.has(field))
          .map(([field, fieldValue]) => [field, visit(fieldValue, field)])));
      }
      if (['forms', 'scriptUrls', 'javascriptResources', 'scriptHints', 'labels', 'options', 'visibleForms'].includes(key)) {
        return { count: value.length };
      }
      return value.map(item => visit(item, key));
    }
    if (!value || typeof value !== 'object') return value;

    if (key === 'forms') return { count: Number(value.count) || 0 };
    if (key === 'bodyDataset' && typeof value === 'object') {
      const allowed = { acPage: new Set(['order-summary', 'installation-payment', 'recommendations', 'internet-offers']), sveltekitPreloadData: new Set(['hover', 'tap']) };
      return Object.fromEntries(Object.entries(value).filter(([field, item]) => allowed[field]?.has(item)));
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([field, fieldValue]) => !(sensitiveKeys.test(field) && typeof fieldValue !== 'boolean'))
      .map(([field, fieldValue]) => [field, visit(fieldValue, field)]));
  }

  return visit(report);
}

async function saveDiagnosticScreenshot(page, screenshotPath) {
  if (!diagnosticInspectionsEnabled) return;
  await captureRedactedScreenshot(page, screenshotPath);
}
// ============================================================
// EXECUTION REPORT
// ============================================================

function saveExecutionReport(report) {
  const reportsDirectory = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(reportsDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runSuffix = String(report.runId || crypto.randomUUID()).replace(/[^a-f0-9-]/gi, '').slice(0, 36);
  const filePath = path.join(reportsDirectory, `execution-report-${timestamp}-${runSuffix}.json`);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(sanitizeExecutionReport(report), null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
    throw error;
  }
  console.log('\nEXECUTION REPORT SAVED');
  console.log(filePath);
  return filePath;
}
// ============================================================
// INPUT VALIDATION
// ============================================================

function validateInput(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('Automation input must be an object.');
  }

  const requiredCustomerFields = [
    'prefix', 'firstName', 'lastName', 'address', 'city',
    'zipCode', 'state', 'unitType', 'serviceAddressType',
    'rentOwn', 'callId', 'customerMove'
  ];

  if (!input.customer || typeof input.customer !== 'object') {
    throw new Error('Missing input.customer.');
  }

  for (const field of requiredCustomerFields) {
    const value = input.customer[field];

    if (
      value === undefined ||
      value === null ||
      String(value).trim() === ''
    ) {
      throw new Error(`Missing required customer field: ${field}`);
    }
  }

  const movingValue = String(input.customer.customerMove).trim().toLowerCase();
  if (['yes', 'true', '1'].includes(movingValue)) {
    const moveInDate = String(input.customer.moveInDate || '').trim();
    if (!moveInDate) {
      throw new Error('customer.moveInDate is required when customerMove is Yes.');
    }
    if (!/^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(moveInDate)) {
      throw new Error('customer.moveInDate must use MM/DD/YYYY or YYYY-MM-DD.');
    }
  }

  if (
    !input.qualification ||
    !['new', 'transfer'].includes(input.qualification.customerType)
  ) {
    throw new Error(
      'qualification.customerType must be "new" or "transfer".'
    );
  }

  if (!input.plan) {
    throw new Error('Missing input.plan.');
  }

  for (const field of [
    'provider', 'speed', 'term', 'monthlyPrice', 'installationPrice'
  ]) {
    if (
      input.plan[field] === undefined ||
      input.plan[field] === null ||
      input.plan[field] === ''
    ) {
      throw new Error(`Missing required plan field: ${field}`);
    }
  }

  if (
    !Number.isFinite(Number(input.plan.monthlyPrice)) ||
    !Number.isFinite(Number(input.plan.installationPrice))
  ) {
    throw new Error('Plan prices must be valid numbers.');
  }

  if (!input.checkout) {
    throw new Error('Missing input.checkout.');
  }

  if (
    !['requested', 'not_requested'].includes(
      input.checkout.broadbandFactLabels
    )
  ) {
    throw new Error(
      'checkout.broadbandFactLabels must be "requested" or "not_requested".'
    );
  }

  if (typeof input.checkout.broadbandFactLabelsRead !== 'boolean') {
    throw new Error(
      'checkout.broadbandFactLabelsRead must be true or false.'
    );
  }

  if (
    !['leased_gateway', 'own_equipment'].includes(
      input.checkout.equipment
    )
  ) {
    throw new Error(
      'checkout.equipment must be "leased_gateway" or "own_equipment".'
    );
  }

  if (typeof input.checkout.nowTv !== 'boolean') {
    throw new Error('checkout.nowTv must be true or false.');
  }
    // Installation & Payment input validation.
  if (!input.installation || typeof input.installation !== 'object') {
    throw new Error('Missing input.installation.');
  }

  if (
    !['standard_shipping', 'professional_installation'].includes(
      input.installation.type
    )
  ) {
    throw new Error(
      'installation.type must be "standard_shipping" or "professional_installation".'
    );
  }

  if (input.installation.confirmInstallation !== undefined && typeof input.installation.confirmInstallation !== 'boolean') {
    throw new Error('installation.confirmInstallation must be a boolean when provided.');
  }
  // Account Holder Qualification input validation.
  if (!input.accountHolder) {
    throw new Error('Missing input.accountHolder.');
  }

  const accountHolderBooleanFields = [
    'isAccountHolder',
    'isExistingProviderCustomer',
    'ezEnroll',
    'automaticPayments',
    'readAcknowledgement',
    'mailingAddressSameAsService',
    'shippingAddressSameAsService'
  ];

  for (const field of accountHolderBooleanFields) {
    if (typeof input.accountHolder[field] !== 'boolean') {
      throw new Error(
        `accountHolder.${field} must be true or false.`
      );
    }
  }

  // Contact information is required for this workflow.
  if (!input.accountHolder.contact) {
    throw new Error('Missing input.accountHolder.contact.');
  }

  const { phone, email } = input.accountHolder.contact;

  if (
    typeof phone !== 'string' ||
    phone.trim() === ''
  ) {
    throw new Error(
      'accountHolder.contact.phone must be a non-empty string.'
    );
  }

  if (!/^\+?[0-9()\-\s]{7,20}$/.test(phone.trim())) {
    throw new Error(
      'accountHolder.contact.phone has an invalid format.'
    );
  }

  if (
    typeof email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new Error(
      'accountHolder.contact.email must be a valid email address.'
    );
  }

  if (!input.execution || input.execution.mode !== 'demo') {
    throw new Error('This automation currently supports demo mode only.');
  }

  const submitDemoOrder = input.execution.submitDemoOrder === true;
  if (
    (input.execution.stopBeforeFinalOrderSubmission !== true && !submitDemoOrder) ||
    (submitDemoOrder && input.execution.mode !== 'demo')
  ) {
    throw new Error('The simulator Order Summary transition requires an explicitly opted-in demo run.');
  }

  if (submitDemoOrder) {
    if (process.env.ALLOW_DEMO_ORDER_SUBMISSION !== 'true') {
      throw new Error('Simulator Order Summary transition is locked. Set ALLOW_DEMO_ORDER_SUBMISSION=true locally only for the isolated demo portal.');
    }
    // EZ-Enroll runs require synthetic card details. Credit-approved runs
    // (ezEnroll=false) do not enter card details and proceed via authorization.
    if (input.accountHolder.ezEnroll === true) {
      const options = input.paymentOptions;
      if (!options || !['Visa', 'MasterCard', 'American Express', 'Discover'].includes(options.cardType) || typeof options.billingAddressSameAsService !== 'boolean') {
        throw new Error('EZ-Enroll paymentOptions must contain a supported cardType and billingAddressSameAsService boolean.');
      }
    }
  }

  if (options.requireSensitiveData === true) {
    validateSensitivePayload(input.sensitiveData, { accountHolder: input.accountHolder });
  }

  console.log('Input validation completed.');
}

// ============================================================
// GENERAL INSPECTION HELPERS
// ============================================================

async function inspectControls(page) {
  return page.locator(
    'input, select, textarea, button'
  ).evaluateAll(elements => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const getLabel = element => {
      const labels = [];

      if (element.labels) {
        for (const label of element.labels) {
          labels.push(label.innerText.trim());
        }
      }

      if (element.id) {
        const label = document.querySelector(
          `label[for="${CSS.escape(element.id)}"]`
        );

        if (label) labels.push(label.innerText.trim());
      }

      const parentLabel = element.closest('label');

      if (parentLabel) {
        labels.push(parentLabel.innerText.trim());
      }

      return [...new Set(labels.filter(Boolean))].join(' | ');
    };

    return elements
      .filter(isVisible)
      .map(element => {
        const isAction = element.tagName === 'BUTTON' ||
          (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type));
        const actionText = isAction ? (element.innerText || element.value || '').trim() : '';
        const result = {
          tag: element.tagName,
          type: element.type || '',
          text: ['Forward >', 'Forward', 'Run Credit Check', 'Confirm Installation >'].includes(actionText)
            ? actionText
            : '',
          checked: element.checked ?? undefined,
          disabled: element.disabled || false
        };

        if (element.tagName === 'SELECT') {
          result.optionCount = element.options.length;
          result.hasSelection = element.selectedIndex >= 0;
        }

        return result;
      });
  });
}

async function inspectChoiceControls(page) {
  return page.locator(
    'input[type="checkbox"], input[type="radio"]'
  ).evaluateAll(elements => {
    return elements.map(element => {
      let labelText = '';

      if (element.labels && element.labels.length) {
        labelText = Array.from(element.labels)
          .map(label => label.innerText.trim())
          .filter(Boolean)
          .join(' | ');
      }

      if (!labelText && element.id) {
        const label = document.querySelector(
          `label[for="${CSS.escape(element.id)}"]`
        );

        if (label) labelText = label.innerText.trim();
      }

      if (!labelText) {
        const parentLabel = element.closest('label');

        if (parentLabel) {
          labelText = parentLabel.innerText.trim();
        }
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return {
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0,
        type: element.type,
        checked: element.checked,
        disabled: element.disabled
      };
    });
  });
}

async function inspectPage(page, heading, screenshotName) {
  if (!diagnosticInspectionsEnabled) return;
  console.log(`\n--- ${heading} ---`);
  console.log('Current URL:', sanitizeDiagnosticUrl(page.url()));
  console.log('Page title:', safeDiagnosticLabel(await page.title()));

  console.log('\nVisible controls:');
  console.log(
    JSON.stringify(await inspectControls(page), null, 2)
  );

  console.log('\nCheckboxes and radio buttons:');
  console.log(
    JSON.stringify(await inspectChoiceControls(page), null, 2)
  );

  console.log('\nPage text omitted from diagnostics.');
  await captureRedactedScreenshot(page, screenshotName);
}

async function inspectCheckout(page) {
  if (!diagnosticInspectionsEnabled) return;
  console.log('\n========================================');
  console.log('CHECKOUT PAGE INSPECTION');
  console.log('========================================');

  console.log('Current URL:', sanitizeDiagnosticUrl(page.url()));
  console.log('Page title:', safeDiagnosticLabel(await page.title()));
  console.log('Checkout body text omitted from diagnostics.');

  console.log('\nVisible controls:');
  console.log(
    JSON.stringify(await inspectControls(page), null, 2)
  );

  console.log('\nChoice controls:');
  console.log(
    JSON.stringify(await inspectChoiceControls(page), null, 2)
  );

  await captureRedactedScreenshot(page, 'providerxx-checkout-detailed-inspection.png');
}

// ============================================================
// EVENT-BASED WAIT HELPERS
// ============================================================

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FORM_FIELD_DELAY_MS = 2000;

function createFieldActionError(step, field, message, cause) {
  const error = new Error(message);
  error.name = 'FieldActionError';
  error.code = 'FORM_FIELD_ACTION_FAILED';
  error.failureDetails = { type: 'field_validation', step, field, message };
  // Do not attach the raw Playwright exception: it can contain typed values.
  return error;
}

async function fillFieldWithDelay(locator, value, step, field) {
  try {
    await locator.fill(value);
    await pause(FORM_FIELD_DELAY_MS);
  } catch (cause) {
    throw createFieldActionError(
      step,
      field,
      `Could not enter ${field}. Check that the field is available and accepts the supplied input.`,
      cause
    );
  }
}

async function selectFieldWithDelay(locator, option, step, field) {
  try {
    await locator.selectOption(option);
    await pause(FORM_FIELD_DELAY_MS);
  } catch (cause) {
    throw createFieldActionError(
      step,
      field,
      `Could not select ${field}. Check that the requested option is available.`,
      cause
    );
  }
}

async function waitForManualCheck(locator, description, timeout = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (await locator.isChecked().catch(() => false)) {
      return true;
    }
    await pause(250);
  }

  throw new Error(
    `${description} was not confirmed manually. Automation stopped before proceeding.`
  );
}

async function waitForManualRadio(radio, description, timeout = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (await radio.isChecked().catch(() => false)) {
      return true;
    }
    await pause(250);
  }

  throw new Error(
    `${description} was not confirmed manually. Automation stopped before proceeding.`
  );
}

// ============================================================
// IFRAME HELPERS
// ============================================================

async function getCheckoutFrame(page) {
  if (checkoutFrameCache.has(page)) return checkoutFrameCache.get(page);
  const iframeElement = page.locator('#checkoutContent');

  await withBoundedRetry(() => iframeElement.waitFor({
    state: 'visible',
    timeout: 10000
  }), {
    retryable: true,
    attempts: 3,
    initialDelayMs: 300,
    maxDelayMs: 900,
    inspect: async () => {
      // Observe only. A timeout never causes navigation or an action replay.
      if (page.isClosed()) throw new Error('Browser page closed while waiting for checkout iframe.');
      await page.title().catch(() => null);
    }
  });

  const checkoutFrame = page.frameLocator('#checkoutContent');

  await withBoundedRetry(() => checkoutFrame.locator('body').waitFor({
    state: 'visible',
    timeout: 10000
  }), {
    retryable: true,
    attempts: 3,
    initialDelayMs: 300,
    maxDelayMs: 900,
    inspect: async () => {
      if (page.isClosed()) throw new Error('Browser page closed while waiting for checkout content.');
      await iframeElement.getAttribute('src').catch(() => null);
    }
  });

  checkoutFrameCache.set(page, checkoutFrame);
  return checkoutFrame;
}

async function inspectProviderCheckoutFrame(page) {
  if (!diagnosticInspectionsEnabled) return;
  console.log('\n========================================');
  console.log('PROVIDER CHECKOUT IFRAME INSPECTION');
  console.log('========================================');

  const iframeDetails = await page.locator(
    '#checkoutContent'
  ).evaluate(element => ({
    sourceConfigured: Boolean(element.src),
    visible:
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0
  }));

  console.log('\nIframe present:', iframeDetails.visible);

  const checkoutFrame = await getCheckoutFrame(page);

  console.log('\nIframe URL:', sanitizeDiagnosticUrl(checkoutFrame.url()));
  console.log('\nIframe page text omitted from diagnostics.');

  console.log('\nIframe controls:');

  const controls = await checkoutFrame.locator(
    'input, button, select, textarea, a'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return {
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0,
        tag: element.tagName,
        type: element.type || '',
        text: ['Forward >', 'Forward', 'Run Credit Check', 'Confirm Installation >'].includes((element.innerText || '').trim())
          ? (element.innerText || '').trim()
          : '',
        checked: element.checked ?? undefined,
        disabled: element.disabled || false
      };
    });
  });

  console.log(JSON.stringify(controls, null, 2));

  const forms = await checkoutFrame.locator('form').evaluateAll(
    elements => elements.map(form => ({
      id: form.id,
      name: form.name,
      actionPresent: Boolean(form.getAttribute('action')),
      method: form.method,
    }))
  );

  console.log('\nVisible iframe form count:', forms.length);

  await captureRedactedScreenshot(page, 'providerxx-checkout-iframe-inspection.png');

  console.log('Provider checkout iframe inspection completed.');
}

async function advanceProviderCheckout(page) {
  console.log('\nAdvancing from checkout overview...');

  const checkoutFrame = await getCheckoutFrame(page);

  const forwardButton = checkoutFrame.locator(
    'input.cbtn[value="Forward >"]'
  );

  if (await forwardButton.count() !== 1) {
    throw new Error(
      'Expected exactly one checkout Forward button.'
    );
  }

  await forwardButton.waitFor({
    state: 'visible',
    timeout: 15000
  });

  if (!(await forwardButton.isEnabled())) {
    throw new Error('Checkout Forward button is disabled.');
  }

  await forwardButton.click();
  await checkoutFrame.locator(
    'input[type="radio"][name="labels"]'
  ).first().waitFor({
    state: 'visible',
    timeout: 15000
  });
  console.log('\n[VERIFIED] Checkout customization controls are visible.');

  await saveDiagnosticScreenshot(page, 'providerxx-checkout-after-forward.png');

  return { customizationControlsVisible: true };
}

// ============================================================
// LABEL AND RADIO HELPERS
// ============================================================

function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[â€™']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findRadioByLabel(group, expectedText) {
  const options = await group.evaluateAll(elements => {
    return elements.map((element, index) => {
      const labels = element.labels
        ? Array.from(element.labels).map(label =>
            label.innerText.trim()
          )
        : [];

      const parentLabel = element.closest('label');

      if (parentLabel) labels.push(parentLabel.innerText.trim());

      return {
        index,
        labels: [...new Set(labels.filter(Boolean))],
        checked: element.checked,
        disabled: element.disabled
      };
    });
  });

  const expected = normalizeLabel(expectedText);

  const matchingOptions = options.filter(option =>
    option.labels.some(label => {
      const actual = normalizeLabel(label);

      return (
        actual === expected ||
        actual.includes(expected) ||
        expected.includes(actual)
      );
    })
  );

  if (matchingOptions.length !== 1) {
    throw new Error(
      `Expected exactly one matching radio option; found ${matchingOptions.length}.`
    );
  }

  if (matchingOptions[0].disabled) {
    throw new Error(
      'The matching radio option is disabled.'
    );
  }

  return {
    index: matchingOptions[0].index,
    options
  };
}

// ============================================================
// PRODUCT CUSTOMIZATION INSPECTION
// ============================================================

async function inspectProviderCustomizations(page) {
  if (!diagnosticInspectionsEnabled) return;
  console.log('\n========================================');
  console.log('PRODUCT CUSTOMIZATION INSPECTION');
  console.log('========================================');

  const checkoutFrame = await getCheckoutFrame(page);

  const details = await checkoutFrame.locator(
    'input, select, textarea, button'
  ).evaluateAll(elements => {
    return elements.map(element => ({
      tag: element.tagName,
      type: element.type || '',
      checked: element.checked ?? undefined,
      required: element.required || false,
      disabled: element.disabled || false,
    }));
  });

  console.log('\nCustomization controls:');
  console.log(JSON.stringify(details, null, 2));

  console.log('\nCustomization page text omitted from diagnostics.');
  await captureRedactedScreenshot(page, 'providerxx-customization-inspection.png');
}

// ============================================================
// APPLY PRODUCT CUSTOMIZATIONS
// ============================================================

async function completeProviderCustomizations(page, input) {
  console.log('\n========================================');
  console.log('APPLYING INPUT-BASED CUSTOMIZATIONS');
  console.log('========================================');

  const checkoutFrame = await getCheckoutFrame(page);
  const choices = input.checkout;

  // Broadband Fact Labels.
  const labelsGroup = checkoutFrame.locator(
    'input[type="radio"][name="labels"]'
  );

  if (await labelsGroup.count() !== 2) {
    throw new Error(
      'Expected exactly two Broadband Fact Labels options.'
    );
  }

  const expectedLabelsText =
    choices.broadbandFactLabels === 'requested'
      ? 'Customer requested Broadband Fact Labels'
      : 'Customer did not request Broadband Fact labels';

  const labelsMatch = await findRadioByLabel(
    labelsGroup,
    expectedLabelsText
  );

  const labelsRadio = labelsGroup.nth(labelsMatch.index);

  if (!(await labelsRadio.isChecked())) {
    await labelsRadio.check();
  }

  if (!(await labelsRadio.isChecked())) {
    throw new Error(
      'Broadband Fact Labels selection could not be verified.'
    );
  }

  console.log(
    'Broadband Fact Labels:',
    choices.broadbandFactLabels
  );

  // Read acknowledgement: follow the explicit test-data value.
  const readCheckbox = checkoutFrame.locator(
    'input[type="checkbox"]'
  );

  if (await readCheckbox.count() !== 1) {
    throw new Error(
      'Expected exactly one Read checkbox on customization page.'
    );
  }

  const readLabels = await readCheckbox.evaluate(element =>
    Array.from(element.labels || []).map(label =>
      label.innerText.trim()
    )
  );

  if (!readLabels.some(label =>
    label.toLowerCase().trim() === 'read'
  )) {
    throw new Error('Could not verify the Read checkbox label.');
  }

  if (choices.broadbandFactLabelsRead !== true) {
    throw new Error(
      'test-data must set checkout.broadbandFactLabelsRead to true ' +
      'after the Broadband Fact Labels disclosure has been read.'
    );
  }

  // The test-data flag explicitly authorizes this demo acknowledgement.
  // Check it automatically and verify the resulting portal state.
  if (!(await readCheckbox.isChecked())) {
    await readCheckbox.check();
  }
  if (!(await readCheckbox.isChecked())) {
    throw new Error('Broadband Fact Labels Read acknowledgement could not be verified.');
  }

  console.log('[VERIFIED] Broadband Fact Labels Read was automatically checked from test-data.');

  console.log(
    'Broadband Fact Labels Read:',
    choices.broadbandFactLabelsRead
  );

  // Equipment.
  const equipmentGroup = checkoutFrame.locator(
    'input[type="radio"][name="equipment"]'
  );

  if (await equipmentGroup.count() !== 2) {
    throw new Error('Expected exactly two equipment options.');
  }

  const expectedEquipmentText =
    choices.equipment === 'leased_gateway'
      ? 'XI/XV Leased Gateway'
      : 'INTERNET/VOICE EQUIPMENT OWN';

  const equipmentMatch = await findRadioByLabel(
    equipmentGroup,
    expectedEquipmentText
  );

  const equipmentRadio = equipmentGroup.nth(equipmentMatch.index);

  if (!(await equipmentRadio.isChecked())) {
    await equipmentRadio.check();
  }

  if (!(await equipmentRadio.isChecked())) {
    throw new Error('Equipment selection verification failed.');
  }

  console.log('Equipment:', choices.equipment);

  // NOW TV.
  const nowTvGroup = checkoutFrame.locator(
    'input[type="radio"][name="nowtv"]'
  );

  const nowTvCount = await nowTvGroup.count();

  if (choices.nowTv === true) {
    if (nowTvCount !== 1) {
      throw new Error(
        `Expected one NOW TV option, found ${nowTvCount}.`
      );
    }

    if (!(await nowTvGroup.isChecked())) {
      await nowTvGroup.check();
    }

    if (!(await nowTvGroup.isChecked())) {
      throw new Error('NOW TV selection could not be verified.');
    }

    console.log('NOW TV selected from input.checkout.nowTv.');
  } else {
    if (
      nowTvCount > 0 &&
      await nowTvGroup.isChecked()
    ) {
      throw new Error(
        'NOW TV is already selected, but input.checkout.nowTv is false. ' +
        'Stopping rather than making an unverified change.'
      );
    }

    console.log('NOW TV not selected.');
  }

  // Final verification.
  console.log('\nVerifying customization selections...');

  if (
  !(await labelsRadio.isChecked()) ||
  !(await readCheckbox.isChecked()) ||
  !(await equipmentRadio.isChecked())
) {
  throw new Error(
    'One or more customization selections failed final verification.'
  );
}

  if (
    choices.nowTv === true &&
    !(await nowTvGroup.isChecked())
  ) {
    throw new Error('NOW TV failed final verification.');
  }

  console.log('All requested customization selections verified.');

  console.log('\nCustomization page text omitted from diagnostics.');

  await saveDiagnosticScreenshot(page, 'providerxx-customizations-applied.png');

  // Move to Account Holder Qualification for inspection.
  const forwardButton = checkoutFrame.locator(
    'input.cbtn[value="Forward >"]'
  );

  if (await forwardButton.count() !== 1) {
    throw new Error(
      'Expected exactly one Forward button after customization.'
    );
  }

  if (!(await forwardButton.isEnabled())) {
    throw new Error(
      'Checkout Forward button is disabled after customization.'
    );
  }

  console.log('\nAdvancing to Account Holder Qualification...');

  await forwardButton.click();
  await checkoutFrame.locator(
    'select[aria-label="Account holder"]'
  ).waitFor({
    state: 'visible',
    timeout: 15000
  });
  console.log('\n[VERIFIED] Account Holder controls are visible.');

  await saveDiagnosticScreenshot(page, 'providerxx-after-customization-forward.png');
}
// ============================================================
// ACCOUNT HOLDER REPORT HELPERS
// ============================================================

function getCheckedAnswer(options) {
  const checked = options.find(option => option.checked);

  if (!checked) {
    return 'not_selected';
  }

  const labelText = normalizeLabel(
    `${checked.value} ${(checked.labels || []).join(' ')}`
  );

  if (/\byes\b/.test(labelText)) return true;
  if (/\bno\b/.test(labelText)) return false;

  return checked.value;
}

function getDisabledAnswer(options, expectedAnswer) {
  return options.some(option => {
    const labelText = normalizeLabel(
      `${option.value} ${(option.labels || []).join(' ')}`
    );

    const optionAnswer = /\byes\b/.test(labelText)
      ? true
      : /\bno\b/.test(labelText)
        ? false
        : null;

    return (
      option.disabled &&
      optionAnswer === expectedAnswer
    );
  });
}

function createReportItem({
  field,
  requested,
  observed,
  status,
  note = '',
  disabledExpectedOption = false
}) {
  return {
    field,
    requested,
    observed,
    status,
    disabledExpectedOption,
    note
  };
}

function printAccountHolderReport(report) {
  const counts = {
    MATCHED: 0,
    UNRESOLVED: 0,
    MISMATCH: 0
  };

  for (const item of report) {
    counts[item.status]++;
  }

  console.log('\n========================================');
  console.log('ACCOUNT HOLDER VALIDATION REPORT');
  console.log('========================================');

  console.log('\nDetailed results:');

  for (const item of report) {
    console.log(`\n[${item.status}] ${item.field}`);
    console.log('  Requested and observed values omitted from terminal diagnostics.');

    if (item.disabledExpectedOption) {
      console.log('  Expected option disabled: YES');
    }

    if (item.note) {
      console.log('  Note:', item.note);
    }
  }

  console.log('\n========================================');
  console.log('ACCOUNT HOLDER REPORT SUMMARY');
  console.log('========================================');

  console.log('Total checks:', report.length);
  console.log('MATCHED:', counts.MATCHED);
  console.log('UNRESOLVED:', counts.UNRESOLVED);
  console.log('MISMATCH:', counts.MISMATCH);

  if (counts.MISMATCH > 0 || counts.UNRESOLVED > 0) {
    console.log('\nRESULT: MANUAL REVIEW REQUIRED.');
  } else {
    console.log('\nRESULT: All inspected Account Holder values match.');
  }
console.log(
  '\nAccount-holder identity and disclosure acknowledgements were confirmed by the user in the portal.'
);

  return {
    total: report.length,
    counts,
    items: report,
    manualReviewRequired:
      counts.MISMATCH > 0 || counts.UNRESOLVED > 0
  };
}

// ============================================================
// ACCOUNT HOLDER CONTACT HANDLING
// ============================================================

async function fillAccountHolderContact(checkoutFrame, input, report) {
  console.log('\n========================================');
  console.log('ACCOUNT HOLDER CONTACT DETAILS');
  console.log('========================================');

  const contact = input.accountHolder.contact;

  // The contact fields are shown after the human has selected
  // the account-holder verification answer in the portal.
  const phoneField = checkoutFrame.locator(
    'input[aria-label="Contact phone"]'
  );

  const emailField = checkoutFrame.locator(
    'input[aria-label="Email Address"]'
  );

  await phoneField.waitFor({
    state: 'visible',
    timeout: 7000
  }).catch(() => {
    throw new Error(
      'Account Holder phone field is not visible. ' +
      'Confirm the account holder manually in the portal first. ' +
      'Automation will not select the verification answer.'
    );
  });

  await emailField.waitFor({
    state: 'visible',
    timeout: 7000
  }).catch(() => {
    throw new Error(
      'Account Holder email field is not visible. ' +
      'Confirm the account holder manually in the portal first.'
    );
  });

  // Fill phone.
  await fillFieldWithDelay(phoneField, contact.phone.trim(), 'Account Holder Validation', 'Contact Phone');

  const observedPhone = await phoneField.inputValue();

  if (observedPhone !== contact.phone.trim()) {
    throw createFieldActionError('Account Holder Validation', 'Contact Phone', 'The entered Contact Phone could not be verified.');
  }

  report.push(createReportItem({
    field: 'accountHolderContactPhone',
    requested: contact.phone,
    observed: observedPhone,
    status: 'MATCHED',
    note: 'Filled using the verified Contact phone selector.'
  }));

  console.log('[MATCHED] Account Holder phone field filled.');

  // Fill email.
  await fillFieldWithDelay(emailField, contact.email.trim(), 'Account Holder Validation', 'Email Address');

  const observedEmail = await emailField.inputValue();

  if (
    observedEmail.toLowerCase() !== contact.email.trim().toLowerCase()
  ) {
    throw createFieldActionError('Account Holder Validation', 'Email Address', 'The entered Email Address could not be verified.');
  }

  report.push(createReportItem({
    field: 'accountHolderContactEmail',
    requested: contact.email,
    observed: observedEmail,
    status: 'MATCHED',
    note: 'Filled using the verified Email Address selector.'
  }));

  console.log('[MATCHED] Account Holder email field filled.');
}

// ============================================================
// ACCOUNT HOLDER CURRENT PROVIDER CUSTOMER ANSWER
// ============================================================

async function applyCurrentProviderCustomerAnswer(
  checkoutFrame,
  input,
  report
) {
  console.log('\nChecking current ProviderXX customer answer...');

  const requested =
    input.accountHolder.isExistingProviderCustomer;

  const currentGroup = checkoutFrame.locator(
    'input[type="radio"][name="current"]'
  );

  const count = await currentGroup.count();

  if (count !== 2) {
    throw new Error(
      `Expected exactly two current ProviderXX customer options; found ${count}.`
    );
  }

  const expectedLabel = requested ? 'Yes' : 'No';

  const match = await findRadioByLabel(
    currentGroup,
    expectedLabel
  );

  const targetRadio = currentGroup.nth(match.index);

  if (!(await targetRadio.isChecked())) {
    await targetRadio.check();
  }

  if (!(await targetRadio.isChecked())) {
    throw new Error(
      `Could not verify current ProviderXX customer = ${expectedLabel}.`
    );
  }

  const observedOptions = await currentGroup.evaluateAll(elements =>
    elements.map(element => ({
      checked: element.checked,
      disabled: element.disabled,
      labels: [
        ...(element.labels
          ? Array.from(element.labels).map(label => label.innerText.trim())
          : []),
        element.closest('label')?.innerText?.trim() || ''
      ].filter(Boolean)
    }))
  );

  const observed = getCheckedAnswer(observedOptions);

  if (observed !== requested) {
    throw new Error(
      'Current ProviderXX customer answer did not match the supplied input.'
    );
  }

  report.push(createReportItem({
    field: 'isExistingProviderCustomer',
    requested,
    observed,
    status: 'MATCHED',
    note: `Selected ${expectedLabel} from the explicit input value.`
  }));

  console.log(
    `[MATCHED] Current ProviderXX customer: ${expectedLabel}`
  );
}

// ============================================================
// ACCOUNT HOLDER QUALIFICATION - CONTACT + INSPECTION
// ============================================================


async function inspectAccountHolderPage(page, input) {
  console.log('\n========================================');
  console.log('ACCOUNT HOLDER QUALIFICATION');
  console.log('========================================');

  const checkoutFrame = await getCheckoutFrame(page);
  const report = [];
  const accountHolder = input.accountHolder;

  // ----------------------------------------------------------
  // 1. Verify the displayed account holder name.
  // ----------------------------------------------------------

  const accountHolderSelect = checkoutFrame.locator(
    'select[aria-label="Account holder"]'
  );

  const displayedAccountHolder =
    await accountHolderSelect.count() === 1
      ? await accountHolderSelect.evaluate(
          element =>
            element.selectedOptions[0]?.textContent?.trim() || ''
        )
      : '';

  const expectedName =
    `${input.customer.firstName} ${input.customer.lastName}`;

  const nameMatches =
    Boolean(displayedAccountHolder) &&
    normalizeLabel(displayedAccountHolder).includes(
      normalizeLabel(expectedName)
    );

  report.push(createReportItem({
    field: 'accountHolderName',
    requested: expectedName,
    observed: displayedAccountHolder || 'not_available',
    status: !displayedAccountHolder
      ? 'UNRESOLVED'
      : nameMatches ? 'MATCHED' : 'MISMATCH',
    note: 'Displayed account holder name comparison.'
  }));

    // ----------------------------------------------------------
  // 2. Select account-holder verification from test data.
  // ----------------------------------------------------------

  const verificationGroup = checkoutFrame.locator(
    'input[type="radio"][name="verified"]'
  );

  const expectedVerification =
    accountHolder.isAccountHolder ? 'Yes' : 'No';

  const verificationMatch = await findRadioByLabel(
    verificationGroup,
    expectedVerification
  );

  const verificationRadio = verificationGroup.nth(
    verificationMatch.index
  );

  // The explicit test-data answer controls this demo radio selection.
  await verificationRadio.check();
  if (!(await verificationRadio.isChecked())) {
    throw new Error(`Account-holder answer could not be selected: ${expectedVerification}`);
  }

  report.push(createReportItem({
    field: 'isAccountHolder',
    requested: accountHolder.isAccountHolder,
    observed: accountHolder.isAccountHolder,
    status: 'MATCHED',
    note: `Selected ${expectedVerification} from test-data.`
  }));

  console.log(
    `[VERIFIED] Account Holder verification: ${expectedVerification}`
  );

    if (accountHolder.isAccountHolder === true) {
    await fillAccountHolderContact(
      checkoutFrame,
      input,
      report
    );
  } else {
    console.log(
      'Account Holder contact fields are not required for the No answer.'
    );
  }

  // ----------------------------------------------------------
  // 4. Current ProviderXX customer answer.
  // ----------------------------------------------------------

  await applyCurrentProviderCustomerAnswer(
    checkoutFrame,
    input,
    report
  );

  // ----------------------------------------------------------
  // 5. Automatically select EZ-Enroll, mailing and shipping.
  // ----------------------------------------------------------

  const automaticSelections = [
    {
      field: 'ezEnroll',
      groupName: 'ez',
      requested: accountHolder.ezEnroll
    },
    {
      field: 'mailingAddressSameAsService',
      groupName: 'mailing',
      requested: accountHolder.mailingAddressSameAsService
    },
    {
      field: 'shippingAddressSameAsService',
      groupName: 'shipping',
      requested: accountHolder.shippingAddressSameAsService
    }
  ];

  for (const selection of automaticSelections) {
    if (typeof selection.requested !== 'boolean') {
      throw new Error(
        `Missing boolean input for accountHolder.${selection.field}`
      );
    }

    const group = checkoutFrame.locator(
      `input[type="radio"][name="${selection.groupName}"]`
    );

    const expectedLabel = selection.requested ? 'Yes' : 'No';

    const match = await findRadioByLabel(
      group,
      expectedLabel
    );

    const radio = group.nth(match.index);

    if (!(await radio.isChecked())) {
      await radio.check();
    }

    const verified = await radio.isChecked();

    report.push(createReportItem({
      field: selection.field,
      requested: selection.requested,
      observed: verified ? selection.requested : 'not_selected',
      status: verified ? 'MATCHED' : 'MISMATCH',
      note: 'Selected from test-data input and verified.'
    }));

    console.log(
      `[${verified ? 'VERIFIED' : 'FAILED'}] ${selection.field}: ${expectedLabel}`
    );
  }

  // ----------------------------------------------------------
  // 6. Verify Automatic Payments.
  // Do not force a disabled option.
  // ----------------------------------------------------------

  const autopayGroup = checkoutFrame.locator(
    'input[type="radio"][name="autopay"]'
  );

  const autopayOptions = await autopayGroup.evaluateAll(
    elements => elements.map(element => ({
      checked: element.checked,
      disabled: element.disabled,
      labels: element.labels
        ? Array.from(element.labels).map(label =>
            label.innerText.trim()
          )
        : []
    }))
  );

  const autopayObserved = getCheckedAnswer(
    autopayOptions.map(option => ({
      ...option,
      labels: option.labels
    }))
  );

  const autopayDisabledExpected =
    typeof autopayObserved === 'boolean' &&
    autopayObserved !== accountHolder.automaticPayments &&
    getDisabledAnswer(
      autopayOptions,
      accountHolder.automaticPayments
    );

  const autopayMatches =
    autopayObserved === accountHolder.automaticPayments;

  report.push(createReportItem({
    field: 'automaticPayments',
    requested: accountHolder.automaticPayments,
    observed: autopayObserved,
    status: autopayMatches
      ? 'MATCHED'
      : autopayDisabledExpected
        ? 'UNRESOLVED'
        : 'MISMATCH',
    note: autopayDisabledExpected
      ? 'Requested option is disabled by the portal. No change was made.'
      : autopayMatches
        ? 'Portal selection matches the input.'
        : 'Portal selection differs from the input.',
    disabledExpectedOption: autopayDisabledExpected
  }));

  console.log('\nAutomatic Payments options:');
  console.log(JSON.stringify(autopayOptions, null, 2));
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // 7. Apply the Account Holder disclosure Read input.
  // ----------------------------------------------------------

  // The checkout iframe can retain hidden checkboxes from previous
  // steps. Only inspect visible checkboxes on the current page.
  const checkboxDetails = await checkoutFrame.locator(
    'input[type="checkbox"]'
  ).evaluateAll(elements =>
    elements.map((element, index) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;

      return {
        index,
        visible,
        checked: element.checked,
        disabled: element.disabled,
        labels: element.labels
          ? Array.from(element.labels).map(label =>
              label.innerText.trim()
            )
          : [],
        parentText:
          element.closest('label')?.innerText?.trim() || ''
      };
    })
  );

  console.log('\nAccount Holder checkbox inspection:');
  console.log(JSON.stringify(checkboxDetails, null, 2));

 // ----------------------------------------------------------
// 7. Apply the Account Holder disclosure Read input.
// ----------------------------------------------------------

if (accountHolder.readAcknowledgement !== true) {
  throw new Error(
    'test-data must set accountHolder.readAcknowledgement to true.'
  );
}

// Scope specifically to the Automatic Payments disclosure.
// This excludes the Broadband Fact Labels Read checkbox.
// Select the disclosure that corresponds to the current EZ-Enroll choice.

if (accountHolder.readAcknowledgement !== true) {
  throw new Error(
    'test-data must set accountHolder.readAcknowledgement to true.'
  );
}

// Identify every mandatory disclosure required by this scenario.
const requiredDisclosures = [];

if (accountHolder.ezEnroll === true) {
  requiredDisclosures.push({
    name: 'EZ-Enroll',
    text: 'By signing up for ProviderXX EZ-Enroll'
  });
}

if (accountHolder.automaticPayments === true) {
  requiredDisclosures.push({
    name: 'Automatic Payments',
    text: "You have opted into ProviderXX's Automatic Payments"
  });
}

if (requiredDisclosures.length === 0) {
  throw new Error(
    'No Account Holder disclosures were identified for acknowledgement.'
  );
}

const verifiedDisclosures = [];

for (const disclosure of requiredDisclosures) {
  const disclosureSection = checkoutFrame
    .locator('.box.tinted')
    .filter({ hasText: disclosure.text });

  // Selecting EZ-Enroll or Automatic Payments causes its disclosure
  // section and Read checkbox to render dynamically. Wait for that
  // specific section before checking its count or locating the checkbox.
  await disclosureSection.first().waitFor({
    state: 'visible',
    timeout: 15000
  });

  if (await disclosureSection.count() !== 1) {
    throw new Error(
      `Expected exactly one ${disclosure.name} disclosure section.`
    );
  }

  const readCheckbox = disclosureSection.locator(
    'label.m-read input[type="checkbox"]'
  );

  await readCheckbox.first().waitFor({
    state: 'visible',
    timeout: 10000
  });

  if (await readCheckbox.count() !== 1) {
    throw new Error(
      `Expected exactly one Read checkbox for ${disclosure.name}.`
    );
  }

  await readCheckbox.waitFor({
    state: 'visible',
    timeout: 10000
  });

  if (!(await readCheckbox.isChecked())) {
    await readCheckbox.check();
  }

  if (!(await readCheckbox.isChecked())) {
    throw new Error(
      `${disclosure.name} Read checkbox could not be verified.`
    );
  }

  verifiedDisclosures.push(disclosure.name);

  console.log(
    `[VERIFIED] ${disclosure.name} Read checkbox checked.`
  );
}

// Record one consolidated acknowledgement in the 10-check report.
report.push(createReportItem({
  field: 'readAcknowledgement',
  requested: true,
  observed: true,
  status: 'MATCHED',
  note: `Verified Read acknowledgements: ${verifiedDisclosures.join(', ')}.`
}));

console.log(
  '[VERIFIED] All required Account Holder Read checkboxes:',
  verifiedDisclosures
);

  // ----------------------------------------------------------
  // 8. Consolidated report.
  // ----------------------------------------------------------

  console.log('\nAccount Holder processing completed.');

  const finalReport = printAccountHolderReport(report);

  await saveDiagnosticScreenshot(page, 'providerxx-account-holder-inspection.png');

  console.log('\nAccount Holder results:');
  console.log('- Account-holder verification: selected and verified by the user in the portal.');
  console.log('- Contact details: filled and verified.');
  console.log('- Current provider answer: handled from input.');
  console.log('- EZ-Enroll: selected from input.');
  console.log('- Mailing and shipping: selected from input.');
  console.log('- Automatic Payments: checked against portal state.');
  console.log('- Disclosure Read: confirmed by the user in the portal.');
  console.log('- Forward button: pending post-validation action.');

  return finalReport;
}

// ============================================================
// SCENARIO 3: EXISTING PROVIDER ACCOUNT POPUP
// ============================================================

async function findAddToExistingAccountAction(page) {
  const pages = [...new Set([page, ...page.context().pages()])];

  for (const candidatePage of pages) {
    if (candidatePage.isClosed()) continue;

    for (const candidateFrame of candidatePage.frames()) {
      const controls = candidateFrame.locator(
        'button, input[type="button"], input[type="submit"], [role="button"], a'
      );

      const matches = await controls.evaluateAll(elements => {
        const isVisible = element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0;
        };

        return elements.map((element, index) => {
          const label = [
            element.innerText,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title')
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

          return {
            index,
            visible: isVisible(element),
            disabled: Boolean(element.disabled),
            matches: /add\s+to\s+existing\s+account/i.test(label)
          };
        }).filter(item => item.visible && !item.disabled && item.matches);
      }).catch(() => []);

      if (matches.length > 0) {
        return {
          locator: controls.nth(matches[0].index),
          page: candidatePage,
          frame: candidateFrame
        };
      }
    }
  }

  return null;
}

async function waitForAndClickAddToExistingAccount(page, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const action = await findAddToExistingAccountAction(page);

    if (action) {
      console.log(
        `[VERIFIED] Add to existing account control detected (${phase}).`
      );

      await action.locator.click({ timeout: 10000 });

      const actionDismissed = await action.locator.waitFor({
        state: 'hidden',
        timeout: 5000
      }).then(() => true).catch(() => false);

      if (!actionDismissed &&
          await action.locator.isVisible().catch(() => false)) {
        throw new Error(
          'Add to existing account was clicked but the portal dialog remained visible.'
        );
      }

      console.log(
        `[ACTION] Add to existing account clicked (${phase}).`
      );
      return true;
    }

    await page.waitForTimeout(250).catch(() => {});
  }

  return false;
}

// ============================================================
// ADVANCE FROM ACCOUNT HOLDER TO INSTALLATION & PAYMENT
// ============================================================

async function advanceAccountHolderToInstallation(page, report, input) {
  const counts = report?.counts;

  // Do not advance if any Account Holder check failed.
  if (
    !counts ||
    counts.MATCHED !== 10 ||
    counts.UNRESOLVED !== 0 ||
    counts.MISMATCH !== 0
  ) {
    throw new Error(
      'Account Holder validation failed. Forward was not clicked.'
    );
  }

  const checkoutFrame = await getCheckoutFrame(page);

  const forwardButton = checkoutFrame.locator(
    'input.cbtn[value="Forward >"]'
  );

  if (await forwardButton.count() !== 1) {
    throw new Error(
      'Expected exactly one Account Holder Forward button.'
    );
  }

  await forwardButton.waitFor({
    state: 'visible',
    timeout: 15000
  });

  if (!(await forwardButton.isEnabled())) {
    throw new Error(
      'Account Holder Forward button is disabled.'
    );
  }

  console.log(
    '\n[VERIFIED] All 10 Account Holder checks passed.'
  );

  // Scenario 3 only: allow the portal's existing-account lookup to finish
  // and inspect real interactive controls, including input[value] buttons.
  if (input.accountHolder?.isExistingProviderCustomer === true) {
    console.log(
      '[WAIT] Waiting up to 5 seconds for Add to existing account before Forward...'
    );

    const handledBeforeForward =
      await waitForAndClickAddToExistingAccount(page, 5000, 'before Forward');

    if (!handledBeforeForward) {
      console.log(
        '[INFO] No existing-account action appeared before Forward; continuing to the portal transition.'
      );
    }
  }

  console.log(
    '[ACTION] Clicking Account Holder Forward button...'
  );


await forwardButton.click({
  noWaitAfter: true
});

console.log('[ACTION] Forward click completed.');

// Some portal builds show the existing-account action only after Forward.
// Scenario 3 gets a second bounded check before the installation transition.
if (input.accountHolder?.isExistingProviderCustomer === true) {
  const handledAfterForward =
    await waitForAndClickAddToExistingAccount(page, 5000, 'after Forward');

  if (!handledAfterForward) {
    console.log(
      '[INFO] No Add to existing account control appeared after Forward.'
    );
  }
}

if (page.isClosed()) {
  throw new Error(
    'The main Playwright page closed immediately after Account Holder Forward.'
  );
}

// Reacquire the checkout frame after the portal transition.

// Reacquire the checkout frame after the portal transition.
const updatedCheckoutFrame = page.frameLocator('#checkoutContent');

console.log('[WAIT] Waiting for Installation and Payment page...');

if (input.accountHolder.ezEnroll === true) {
  // EZ-Enroll produces a qualification status and skips the credit form.
  await updatedCheckoutFrame.getByText(
    'ORDER QUALIFICATION STATUS',
    { exact: true }
  ).waitFor({ state: 'visible', timeout: 30000 });
} else if (input.accountHolder?.isExistingProviderCustomer === true) {
  // Existing ProviderXX customers may be routed directly to installation
  // after the portal attaches the order to the existing account. Do not
  // require the separate CREDIT CHECK heading if installation controls
  // are already present; runSimulatorCreditCheck verifies the actual form.
  const installationOptions = updatedCheckoutFrame.locator(
    'input[type="radio"][name="itype"]'
  );
  const creditHeading = updatedCheckoutFrame.getByText(
    'CREDIT CHECK',
    { exact: true }
  );
  const ssnField = updatedCheckoutFrame.getByLabel(
    'Social Security Number',
    { exact: true }
  );

  const transitionDeadline = Date.now() + 30000;
  let transitionFound = false;

  while (Date.now() < transitionDeadline) {
    const headingVisible = await creditHeading.isVisible().catch(() => false);
    const ssnVisible = await ssnField.isVisible().catch(() => false);
    const installationVisible =
      await installationOptions.first().isVisible().catch(() => false);

    if (headingVisible || ssnVisible || installationVisible) {
      transitionFound = true;
      break;
    }

    await page.waitForTimeout(250);
  }

  if (!transitionFound) {
    throw new Error(
      'Scenario 3 did not reach a recognizable credit-check or installation state after Account Holder Forward.'
    );
  }
} else {
  await updatedCheckoutFrame.getByText(
    'CREDIT CHECK',
    { exact: true }
  ).waitFor({ state: 'visible', timeout: 30000 });
}

if (input.accountHolder?.isExistingProviderCustomer === true) {
  await updatedCheckoutFrame.locator(
    'input[type="radio"][name="itype"]'
  ).first().waitFor({
    state: 'visible',
    timeout: 30000
  });
} else {
  await updatedCheckoutFrame.getByText(
    'Select Installation Type',
    { exact: false }
  ).waitFor({
    state: 'visible',
    timeout: 15000
  });
}

console.log(
  '[COMPLETED] Installation and Payment page reached.'
);


  console.log(
    '[COMPLETED] Automatically advanced to Step 3.'
  );

  return {
    forwardClicked: true,
    matched: counts.MATCHED,
    unresolved: counts.UNRESOLVED,
    mismatch: counts.MISMATCH,
    step3Reached: true
  };
}

// ============================================================
// PLAN HELPERS
// ============================================================

function moneyMatches(actual, expected) {
  const actualNumber = Number(
    String(actual).replace(/[$,\s]/g, '')
  );

  return (
    Number.isFinite(actualNumber) &&
    Math.abs(actualNumber - Number(expected)) < 0.001
  );
}

function speedMatches(text, speed) {
  const normalizedSpeed = String(speed)
    .replace(/\s+/g, '')
    .toLowerCase();

  const normalizedText = String(text)
    .replace(/\s+/g, '')
    .toLowerCase();

  return normalizedText.includes(normalizedSpeed);
}

function termMatches(text, term) {
  const normalized = String(term).toLowerCase();

  if (normalized === '1-year') {
    return /1\s*[- ]?\s*year/i.test(text);
  }

  if (normalized === '2-year') {
    return /2\s*[- ]?\s*year/i.test(text);
  }

  if (normalized === 'no-contract') {
    return /no\s*[- ]?\s*contract|month\s*[- ]?\s*to\s*month/i.test(text);
  }

  return String(text).toLowerCase().includes(normalized);
}

async function selectInstallationOption(checkoutFrame, installationType) {
  const options = checkoutFrame.locator('input[type="radio"][name="itype"]');
  const count = await options.count();
  if (count !== 2) {
    throw new Error(`Expected 2 installation radio options, found ${count}.`);
  }

  const labels = {
    standard_shipping: 'STANDARD SHIPPING - (Free)',
    professional_installation: 'PRO_INSTALL - (install:$100.00)'
  };
  const expectedLabel = labels[installationType];
  if (!expectedLabel) throw new Error(`Unsupported installation type: ${installationType}`);

  const match = await findRadioByLabel(options, expectedLabel);
  const option = options.nth(match.index);
  await option.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await option.isEnabled())) throw new Error('Requested installation option is disabled.');
  if (!(await option.isChecked())) await option.check();
  if (!(await option.isChecked())) throw new Error(`Installation selection failed: ${installationType}`);
  return expectedLabel;
}
function planMatches(plan, requestedPlan) {
  let hiddenData = {};

  try {
    hiddenData = JSON.parse(plan.hiddenJson || '{}');
  } catch {
    console.log('Invalid hidden JSON for plan:', plan.buttonIndex);
    return false;
  }

  console.log('\n--- PLAN MATCH DIAGNOSTICS ---');
  console.log('Button:', plan.buttonIndex);
  console.log('Visible text:', plan.text);
  console.log('Hidden data:', hiddenData);

  const providerName = hiddenData.providerName || '';
  const productName = hiddenData.productname || '';
  const recurringPrice = hiddenData.recuring;

  const allPlanText = [
    plan.text || '',
    providerName,
    productName
  ].join(' ');

  const providerMatch = providerName.toLowerCase().includes(
    String(requestedPlan.provider).toLowerCase()
  );

  const speedMatch = speedMatches(
    allPlanText,
    requestedPlan.speed
  );

  const contractMatch = termMatches(
    allPlanText,
    requestedPlan.term
  );

  const priceMatch = moneyMatches(
    recurringPrice,
    requestedPlan.monthlyPrice
  );

  console.log({
    providerName,
    productName,
    recurringPrice,
    providerMatch,
    speedMatch,
    contractMatch,
    priceMatch
  });

  return (
    providerMatch &&
    speedMatch &&
    contractMatch &&
    priceMatch
  );
}
async function findProviderPlans(page, requestedPlan) {
  const providerButtons = page.locator('input.ViewDetailsBtn');
  const buttonCount = await providerButtons.count();

  console.log(`Found ${buttonCount} View Details buttons.`);

  const plans = [];

  for (let i = 0; i < buttonCount; i++) {
    const button = providerButtons.nth(i);

    const details = await button.evaluate(element => {
      let parent = element;

      for (let level = 0; level < 8 && parent; level++) {
        const text = (parent.innerText || '').trim();

        if (
          text.length > 20 &&
          parent.querySelector('.singleHiddenJson')
        ) {
          return {
            text,
            hiddenJson: parent.querySelector(
              '.singleHiddenJson'
            ).getAttribute('value')
          };
        }

        parent = parent.parentElement;
      }

      return { text: '', hiddenJson: null };
    });

    plans.push({
      buttonIndex: i,
      buttonId: await button.getAttribute('id'),
      ...details
    });
  }

  const matchingPlans = plans.filter(plan =>
    planMatches(plan, requestedPlan)
  );

  console.log('\nMatching plans:');
  console.log(JSON.stringify(matchingPlans, null, 2));

  if (matchingPlans.length !== 1) {
    throw new Error(
      `Expected exactly one matching plan for ` +
      `${requestedPlan.provider}, ${requestedPlan.speed}, ` +
      `${requestedPlan.term}, $${requestedPlan.monthlyPrice}/month. ` +
      `Found ${matchingPlans.length}. No plan will be added.`
    );
  }

  return matchingPlans[0];
}

function isInternetOffersUrl(value) {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '').toLowerCase();
    return pathname.endsWith('/recommendations/internet');
  } catch {
    return false;
  }
}

function isRecommendationsUrl(value) {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '').toLowerCase();
    return pathname.endsWith('/recommendations');
  } catch {
    return false;
  }
}

async function openInternetOffers(page, options = {}) {
  const transitionTimeout = options.transitionTimeout ?? 15000;
  const offersTimeout = options.offersTimeout ?? 15000;
  const internetTab = page.locator(
    'a[data-ac-href*="CategoryName=INTERNET"]'
  );
  const viewDetails = page.locator('input.ViewDetailsBtn').first();
  const isOffersPage = () => isInternetOffersUrl(page.url());

  if (!isOffersPage()) {
    const tabCount = await internetTab.count();
    if (tabCount !== 1) {
      throw new Error(`Expected one Internet category link, found ${tabCount}.`);
    }

    await internetTab.waitFor({ state: 'visible', timeout: offersTimeout });
    if (!(await internetTab.isEnabled())) {
      throw new Error('Internet category link is disabled.');
    }

    // The portal link uses href="#" and data-ac-href for its client-side
    // route. Verify the route after each click. Retry once only if the browser
    // is still on Recommendations, so a completed navigation is never replayed.
    let transitioned = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (isOffersPage()) {
        transitioned = true;
        break;
      }

      await internetTab.click();
      try {
        await page.waitForURL(isInternetOffersUrl, {
          timeout: transitionTimeout
        });
        transitioned = true;
        break;
      } catch (error) {
        if (isOffersPage()) {
          transitioned = true;
          break;
        }

        if (attempt === 1 && isRecommendationsUrl(page.url())) {
          await inspectBrowserState(page);
          continue;
        }

        throw new Error(
          'Internet category click did not reach the Internet offers route.'
        );
      }
    }

    if (!transitioned) {
      throw new Error('Internet category navigation was not verified.');
    }
  }

  await viewDetails.waitFor({ state: 'visible', timeout: offersTimeout });
  if (!(await viewDetails.isEnabled())) {
    throw new Error('Internet offers loaded with a disabled View Details control.');
  }
}

// ============================================================
// MAIN AUTOMATION WORKFLOW
// ============================================================
// ============================================================
// STEP 3: INSTALLATION TYPE
// ============================================================

async function getFreshSensitiveData(input) {
  if (isSensitivePayloadFresh(input.sensitiveData)) {
    validateSensitivePayload(input.sensitiveData, { accountHolder: input.accountHolder });
    return input.sensitiveData;
  }

  if (typeof input.requestSensitiveRefresh !== 'function') {
    const error = new Error('Sensitive input expired. Run the scenario again and re-enter the required details.');
    error.code = 'SENSITIVE_INPUT_EXPIRED';
    throw error;
  }

  console.log('[INPUT] Seven-minute sensitive-data window expired. Please re-enter the required details.');
  zeroSensitivePayload(input.sensitiveData);
  const refreshed = await input.requestSensitiveRefresh();
  validateSensitivePayload(refreshed, { accountHolder: input.accountHolder });
  input.sensitiveData = refreshed;
  return refreshed;
}

function normalizedDateDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function runSimulatorCreditCheck(checkoutFrame, input) {
  const ezEnroll = input.accountHolder?.ezEnroll;

  if (ezEnroll === true) {
    const installationOptions = checkoutFrame.locator('input[type="radio"][name="itype"]');
    await checkoutFrame.getByText('ORDER QUALIFICATION STATUS', { exact: true })
      .waitFor({ state: 'visible', timeout: 15000 });
    await installationOptions.first().waitFor({ state: 'visible', timeout: 15000 });
    if (await installationOptions.count() !== 2) {
      throw new Error('EZ-Enroll transition did not reach the installation choices.');
    }
    return {
      performed: false,
      approved: null,
      status: 'not_required_ez_enroll',
      dataSource: 'not_required_ez_enroll'
    };
  }

  if (ezEnroll !== false) throw new Error('EZ-Enroll must be selected before the simulator credit check.');

  // Existing ProviderXX customers can be routed directly to installation
  // once the portal attaches the order to their account. Skip only when the
  // credit form is absent AND both installation choices are actually visible.
  if (input.accountHolder?.isExistingProviderCustomer === true) {
    const ssnField = checkoutFrame.getByLabel(
      'Social Security Number',
      { exact: true }
    );
    const dobField = checkoutFrame.getByLabel(
      'Date of Birth',
      { exact: true }
    );
    const installationOptions = checkoutFrame.locator(
      'input[type="radio"][name="itype"]'
    );

    const ssnVisible = await ssnField.isVisible().catch(() => false);
    const dobVisible = await dobField.isVisible().catch(() => false);

    if (!ssnVisible && !dobVisible) {
      await installationOptions.first().waitFor({
        state: 'visible',
        timeout: 15000
      });

      if (await installationOptions.count() !== 2) {
        throw new Error(
          'Existing ProviderXX customer reached an unexpected page: credit fields are absent and installation choices are incomplete.'
        );
      }

      console.log(
        '[VERIFIED] Existing ProviderXX account flow does not present a credit form; installation choices are available.'
      );

      return {
        performed: false,
        approved: null,
        status: 'not_required_existing_provider_account',
        dataSource: 'portal_existing_account_flow'
      };
    }
  }

  let creditCheckStage = 'sensitive_payload_preflight';
  try {
    let sensitiveData = await getFreshSensitiveData(input);
    const ssnField = checkoutFrame.getByLabel('Social Security Number', { exact: true });
    const dobField = checkoutFrame.getByLabel('Date of Birth', { exact: true });
    await ssnField.waitFor({ state: 'visible', timeout: 15000 });
    await dobField.waitFor({ state: 'visible', timeout: 15000 });

    creditCheckStage = 'ssn_fill_started';
    await fillFieldWithDelay(ssnField, sensitiveData.identity.ssn, 'Demo Credit Check, Installation and Payment', 'SSN');
    const actualSsn = String(await ssnField.inputValue()).replace(/\D/g, '');
    if (actualSsn !== sensitiveData.identity.ssn) {
      throw createFieldActionError('Demo Credit Check, Installation and Payment', 'SSN', 'The entered SSN could not be verified.');
    }
    creditCheckStage = 'ssn_value_verified';

    // Check the seven-minute window again immediately before using the DOB.
    sensitiveData = await getFreshSensitiveData(input);
    await fillFieldWithDelay(dobField, sensitiveData.identity.dob, 'Demo Credit Check, Installation and Payment', 'Date of Birth');
    if (normalizedDateDigits(await dobField.inputValue()) !== normalizedDateDigits(sensitiveData.identity.dob)) {
      throw createFieldActionError('Demo Credit Check, Installation and Payment', 'Date of Birth', 'The entered Date of Birth could not be verified.');
    }
    creditCheckStage = 'dob_value_verified';

    const runCreditButton = checkoutFrame.locator('input.cbtn[value="Run Credit Check"]');
    if (await runCreditButton.count() !== 1) throw new Error('Expected exactly one simulator Run Credit Check button.');
    await runCreditButton.waitFor({ state: 'visible', timeout: 10000 });
    if (!(await runCreditButton.isEnabled())) throw new Error('Simulator Run Credit Check button is disabled.');

    sensitiveData = await getFreshSensitiveData(input);
    // If the payload was refreshed at the last check, keep both fields in sync.
    await fillFieldWithDelay(ssnField, sensitiveData.identity.ssn, 'Demo Credit Check, Installation and Payment', 'SSN');
    await fillFieldWithDelay(dobField, sensitiveData.identity.dob, 'Demo Credit Check, Installation and Payment', 'Date of Birth');
    creditCheckStage = 'credit_button_click_started';
    await runCreditButton.click();
    creditCheckStage = 'credit_button_click_completed';

    const status = checkoutFrame.getByText(/Credit Check Status:/i).first();
    await status.waitFor({ state: 'visible', timeout: 15000 });
    const portalStatus = (await status.innerText()).trim();
    if (!portalStatus) throw new Error('Simulator did not display a credit-check result.');

    const approved = /\bCredit Check Status:\s*APPROVED\b/i.test(portalStatus);
    const safeStatus = approved
      ? 'APPROVED'
      : /\bCredit Check Status:\s*DECLINED\b/i.test(portalStatus)
        ? 'DECLINED'
        : 'UNRECOGNIZED_RESULT';
    console.log('[VERIFIED] Simulator credit-check result:', safeStatus);
    if (!approved) {
      const error = new Error('Simulator credit check did not return an approval; automation stopped.');
      error.creditCheckResult = { performed: true, simulated: true, approved: false, status: safeStatus, dataSource: 'jwe-client-encrypted-input' };
      throw error;
    }
    return { performed: true, simulated: true, approved: true, status: safeStatus, dataSource: 'jwe-client-encrypted-input' };
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      creditCheckFailureStages.set(error, creditCheckStage);
    }
    throw error;
  } finally {
    if (input.sensitiveData?.identity) {
      input.sensitiveData.identity.ssn = '';
      input.sensitiveData.identity.dob = '';
    }
  }
}

async function inspectCheckoutNavigation(checkoutFrame) {
  return checkoutFrame.locator('html').evaluate(html => {
    const document = html.ownerDocument;

    const safeLabel = value => {
      const label = String(value || '').trim();
      const allowed = [
        'Order Summary',
        'Credit Check',
        'Order Qualification Status',
        'Installation and Payment',
        'Installation & Payment',
        'ProviderXX Checkout',
        'Account Holder Qualification',
        'Product Customization',
        'Installation',
        'Authorization'
      ];

      return allowed.includes(label)
        ? label
        : label ? '[redacted]' : '';
    };

    const safeUrl = value => {
      try {
        const url = new URL(value, document.location.href);

        const allowedPaths = new Set([
          '/',
          '/allconnect-frame/order-summary/',
          '/allconnect-frame/recommendations/',
          '/allconnect-frame/internet-offers/',
          '/allconnect-frame/checkout/',
          '/allconnect-frame/installation-payment/'
        ]);

        const path = url.pathname === '/'
          ? '/'
          : `${url.pathname.replace(/\/+$/, '')}/`;

        return `${url.origin}${allowedPaths.has(path) ? path : '/[redacted-path]'}`;
      } catch {
        return '[unavailable]';
      }
    };

    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;
    };


const getFormDetails = form => {
  if (!form) return null;

  const submitControls = Array.from(
    form.querySelectorAll(
      'button, input[type="submit"], input[type="image"]'
    )
  );

  return {
    present: true,
    idPresent: Boolean(form.id),
    actionPresent: Boolean(form.getAttribute('action')),
    action: safeUrl(form.action),
    method: (form.getAttribute('method') || 'get').toUpperCase(),
    enctype: form.enctype || '',
    target: ['_self', '_blank', '_parent', '_top'].includes(
      form.getAttribute('target')
    )
      ? form.getAttribute('target')
      : '[redacted]',
    inlineOnsubmitPresent: Boolean(
      form.getAttribute('onsubmit')
    ),
    submitControlCount: submitControls.length
  };
};

const controls = Array.from(
  document.querySelectorAll(
    'button, input:not([type="hidden"]), select, textarea, a'
  )
)
  .filter(isVisible)
  .map(element => {
    const candidate =
      element.tagName === 'BUTTON' ||
      (
        element.tagName === 'INPUT' &&
        ['button', 'submit', 'reset'].includes(element.type)
      )
        ? (element.innerText || element.value || '').trim()
        : '';

    const allowedActions = [
      'Forward >',
      'Forward',
      'Run Credit Check',
      'Confirm Installation >'
    ];

    const form = element.form || null;
    const formAction = element.getAttribute('formaction');
    const formMethod = element.getAttribute('formmethod');

       return {
      tag: element.tagName,
      type: element.getAttribute('type'),
      buttonId: element.id || null,
      buttonValue: element.getAttribute('value') || null,
      text: allowedActions.includes(candidate) ? candidate : '',
      disabled: Boolean(element.disabled),
      required: Boolean(element.required),

      insideForm: Boolean(form),
      formDetails: getFormDetails(form),

      formActionPresent: Boolean(formAction),
      formAction: formAction ? safeUrl(formAction) : null,
      formMethod: formMethod
        ? formMethod.toUpperCase()
        : null,

      formNoValidate: Boolean(element.formNoValidate),

            inlineOnclickPresent: Boolean(
        element.getAttribute('onclick')
      ),

      idPresent: Boolean(element.id),

      classPresent: Boolean(
        typeof element.className === 'string' &&
        element.className.trim().length > 0
      ),

      dataAttributeNames: Array.from(element.attributes)
        .map(attribute => attribute.name)
        .filter(name =>
          name.startsWith('data-') &&
          /^[a-zA-Z0-9_-]{1,60}$/.test(name)
        )
        .slice(0, 20),

      parentTag: element.parentElement?.tagName || null,

      parentIdPresent: Boolean(
        element.parentElement?.id
      ),

      parentFormPresent: Boolean(
        Boolean(element.parentElement?.closest('form'))
      ),

      closestSectionTag:
        element.closest('section, main, form')?.tagName || null,

      checked: typeof element.checked === 'boolean'
        ? element.checked
        : undefined,

      ariaInvalid:
        element.getAttribute('aria-invalid') === 'true',

      valid: typeof element.checkValidity === 'function'
        ? element.checkValidity()
        : undefined
    };
  });


    const forms = {
      count: document.forms.length
    };

    const headings = Array.from(document.querySelectorAll(
      'h1, h2, h3, h4, legend, [role="heading"]'
    ))
      .filter(isVisible)
      .map(element => safeLabel(element.innerText))
      .filter(Boolean);

    const bodyText = document.body.innerText || '';

    const relevantMessages = [
      /credit check status/i.test(bodyText)
        ? 'credit_check_status_present' : null,
      /payment|card/i.test(bodyText)
        ? 'payment_text_present' : null,
      /error|required|invalid/i.test(bodyText)
        ? 'validation_text_present' : null,
      /order summary/i.test(bodyText)
        ? 'order_summary_text_present' : null,
      /forward/i.test(bodyText)
        ? 'forward_text_present' : null
    ].filter(Boolean);

    const scriptCount = document.scripts.length;

    const bodyDataset = {};

    for (const key of ['acPage', 'sveltekitPreloadData']) {
      const value = document.body.dataset[key];

      if (
        key === 'acPage' &&
        [
          'order-summary',
          'installation-payment',
          'recommendations',
          'internet-offers'
        ].includes(value)
      ) {
        bodyDataset[key] = value;
      }

      if (
        key === 'sveltekitPreloadData' &&
        ['hover', 'tap'].includes(value)
      ) {
        bodyDataset[key] = value;
      }
    }
    const javascriptResourceEntries = performance
      .getEntriesByType('resource')
      .filter(entry => /\.(m?js)(\?|$)/i.test(entry.name));

    const javascriptResources = javascriptResourceEntries
      .slice(0, 50)
      .map(entry => {
        try {
          const resourceUrl = new URL(
            entry.name,
            document.location.href
          );

          const filename = resourceUrl.pathname
            .split('/')
            .pop() || '';

          const safeFilename =
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.m?js$/i.test(filename)
              ? filename.replace(/\d{7,}/g, '[id]')
              : '[redacted]';

          return {
            sameOrigin:
              resourceUrl.origin === document.location.origin,
            filename: safeFilename
          };
        } catch {
          return {
            sameOrigin: false,
            filename: '[unavailable]'
          };
        }
      });

    return {
      url: safeUrl(document.location.href),
      title: safeLabel(document.title),
      bodyDataset,

      summaryFormPresent: (() => {
        const form = document.querySelector('#summaryForm');
        return Boolean(form && isVisible(form));
      })(),

      headings,
      relevantMessages,
      javascriptResourceCount: javascriptResourceEntries.length,
      javascriptResources,

      renderState: {
        readyState: document.readyState,
        bodyTextPresent: bodyText.trim().length > 0,
        bodyTextLength: bodyText.length,
        scriptElementCount: scriptCount,
        visibleHeadingCount: Array.from(
          document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[role="heading"]'
          )
        ).filter(isVisible).length,
        visibleControlCount: controls.length
      },

      forms,
      controls
    };
  });
}

async function collectOrderSummaryEvidence(checkoutFrame, input) {
  const installationOptionFee =
    input.installation.type === 'professional_installation' ? 100 : 0;

  const requested = {
    provider: String(input.plan.provider),
    monthlyPrice: Number(input.plan.monthlyPrice).toFixed(2),
    installationPrice: (
      Number(input.plan.installationPrice) + installationOptionFee
    ).toFixed(2)
  };

  return checkoutFrame.locator('html').evaluate((html, expected) => {
    const document = html.ownerDocument;

    const isVisible = element => {
      if (!element) return false;

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return false;
      }

      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const parentStyle = window.getComputedStyle(parent);

        if (
          parentStyle.display === 'none' ||
          parentStyle.visibility === 'hidden'
        ) {
          return false;
        }
      }

      return true;
    };

    const summary = document.querySelector('.summary');
    const summaryContainerVisible = Boolean(
      summary && isVisible(summary)
    );

    const summaryItems = summaryContainerVisible
      ? Array.from(summary.querySelectorAll('.item')).filter(isVisible)
      : [];

    const summaryText = summaryContainerVisible
      ? String(summary.innerText || '').replace(/\s+/g, ' ').trim()
      : '';

    const bodyText = document.body.innerText || '';
    const titleMatches = /^order summary$/i.test(document.title);

    const summaryState =
      /\/allconnect-frame\/order-summary\/?$/i.test(
        document.location.pathname
      ) ||
      titleMatches ||
      /order[- ]summary/i.test(
        document.body.dataset.acPage || ''
      );

    const normalizeText = value =>
      String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const moneyAmounts = text => {
      const matches = String(text || '').match(
        /\$?\s*[\d,]+(?:\.\d{1,2})?/g
      ) || [];

      return matches.map(value => {
        const amount = Number(value.replace(/[$,\s]/g, ''));
        return Number.isFinite(amount)
          ? Math.round(amount * 100)
          : null;
      }).filter(value => value !== null);
    };

    const summaryAmounts = moneyAmounts(summaryText);

    const expectedMonthlyCents = Math.round(
      Number(expected.monthlyPrice) * 100
    );

    const expectedInstallationCents = Math.round(
      Number(expected.installationPrice) * 100
    );

    const providerPresent =
      summaryContainerVisible &&
      normalizeText(summaryText).includes(
        normalizeText(expected.provider)
      );

    const monthlyPricePresent =
      summaryContainerVisible &&
      summaryAmounts.includes(expectedMonthlyCents);

    const installationPricePresent =
      summaryContainerVisible &&
      summaryAmounts.includes(expectedInstallationCents);

    const checkoutCompletedVisible =
      /\bCHECKOUT_COMPLETED\b/i.test(summaryText) ||
      /\bCHECKOUT_COMPLETED\b/i.test(bodyText);

    const headings = Array.from(document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [role="heading"]'
    )).filter(isVisible);

    const bodyDataset = {};

    for (const key of ['acPage', 'sveltekitPreloadData']) {
      if (document.body.dataset[key]) {
        bodyDataset[key] = document.body.dataset[key];
      }
    }

    return {
      url: `${document.location.origin}${document.location.pathname}`,
      title: titleMatches ? 'Order Summary' : '',
      bodyDataset,

      summaryState,
      summaryHeading: titleMatches,
      visibleSummaryHeading: headings.some(element =>
        /^order summary$/i.test(element.innerText.trim())
      ),

      summaryContainerVisible,
      summaryItemCount: summaryItems.length,

      checkoutCompletedVisible,

      expectedFields: {
        provider: providerPresent,
        monthlyPrice: monthlyPricePresent,
        installationPrice: installationPricePresent
      },

      renderState: {
        readyState: document.readyState,
        bodyTextPresent: bodyText.trim().length > 0,
        visibleHeadingCount: headings.length,
        summaryContainerPresent: Boolean(summary),
        summaryContainerVisible,
        summaryItemCount: summaryItems.length,
        summaryTextPresent: summaryText.length > 0,
        checkoutCompletedVisible
      }
    };
  }, requested);
}
async function clickForwardAndVerifyOrderSummary(
  page,
  checkoutFrame,
  input,
  forwardButton,
  navigationBefore,
  options = {}
) {
  const inspectWithTimeout = (task, timeoutMs, fallback) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    Promise.resolve().then(task).then(value => {
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
  const forwardControl = navigationBefore.controls.find(control =>
    control.text === 'Forward >'
  );
  const submitControlPresent = navigationBefore.controls.some(control =>
    control.type === 'submit'
  );
  if (
    !forwardControl ||
    forwardControl.type !== 'button' ||
    forwardControl.insideForm ||
    forwardControl.formId ||
    forwardControl.formActionPresent ||
    forwardControl.formAction ||
    submitControlPresent ||
    !(await forwardButton.isEnabled())
  ) {
    throw new Error('Forward is not verified as a non-submit navigation control.');
  }

  const checkoutIframe = await page.locator('#checkoutContent').elementHandle();
  const checkoutDocument = await checkoutIframe?.contentFrame();
  if (!checkoutDocument) throw new Error('Checkout iframe was unavailable before Forward.');
  const urlBefore = checkoutDocument.url();
  const routeResponses = [];
  const recordSummaryResponse = response => {
    try {
      const responseUrl = new URL(response.url());
      if (/\/allconnect-frame\/order-summary(?:\/|$)/i.test(responseUrl.pathname)) {
        routeResponses.push({
          path: responseUrl.pathname,
          status: response.status()
        });
      }
    } catch {
      // Ignore malformed or non-HTTP response URLs.
    }
  };
  page.on('response', recordSummaryResponse);

  let domContentLoadedReached = false;
let networkIdleReached = false;
let renderWaitMs = 0;
let renderWaitStatus = 'not_summary_route';
let summaryRouteDetected = false;
  const renderTimeoutMs = options.renderTimeoutMs ?? 15000;
  const summaryRoutePattern = /\/allconnect-frame\/order-summary\/?$/i;
  const isSummaryRoute = async () => {
    if (summaryRoutePattern.test(checkoutDocument.url())) return true;
    return checkoutDocument.locator('body').evaluate(body =>
      /order[- ]summary/i.test(body.dataset.acPage || '')
    ).catch(() => false);
  };

  try {
    // The simulator's Forward is one-shot and guarded above. Never replay it.
    // Navigation is verified explicitly below. Do not let Playwright's
    // implicit post-click navigation wait consume the test/run timeout when
    // the simulator changes an iframe route without rendering summary content.
    await forwardButton.click({ noWaitAfter: true, timeout: 5000 });
    await checkoutDocument.waitForFunction(previousUrl => {
  if (location.href !== previousUrl) return true;

  const visible = element => {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const summaryTitle = /^order summary$/i.test(document.title);

  const summaryRouteState =
    /order[- ]summary/i.test(document.body?.dataset.acPage || '');

  const summaryContainer = document.querySelector('.summary');

  const summaryVisible = visible(summaryContainer);

  const checkoutCompleted =
    /\bCHECKOUT_COMPLETED\b/i.test(
      document.body?.innerText || ''
    );

  return (
    summaryTitle ||
    summaryRouteState ||
    (summaryVisible && checkoutCompleted)
  );
}, urlBefore, {
  timeout: options.transitionTimeoutMs ?? 10000
}).catch(() => null);
    summaryRouteDetected = await isSummaryRoute().catch(() => false);

if (summaryRouteDetected) {
      // SvelteKit may update the iframe route before its route content has
      // hydrated. Let document/network activity settle, then await visible
      // summary evidence. Neither wait triggers another action.
      await checkoutDocument.waitForLoadState('domcontentloaded', {
        timeout: options.domContentLoadedTimeoutMs ?? 3000
      }).then(() => { domContentLoadedReached = true; }).catch(() => {});
      await checkoutDocument.waitForLoadState('networkidle', {
        timeout: options.networkIdleTimeoutMs ?? 5000
      }).then(() => { networkIdleReached = true; }).catch(() => {});

      const expected = {
        customerName: `${input.customer.firstName} ${input.customer.lastName}`,
        provider: input.plan.provider,
        monthlyPrice: Number(input.plan.monthlyPrice).toFixed(2),
        installationPrice: (
          Number(input.plan.installationPrice) +
          (input.installation.type === 'professional_installation' ? 100 : 0)
        ).toFixed(2)
      };
      const waitStart = Date.now();
      try {
        await checkoutDocument.waitForFunction(() => {
  const summary = document.querySelector('.summary');

  if (!summary) return false;

  const rect = summary.getBoundingClientRect();
  const style = getComputedStyle(summary);

  const visible =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect.width > 0 &&
    rect.height > 0;

  const itemCount = summary.querySelectorAll('.item').length;

  const checkoutCompleted =
    /\bCHECKOUT_COMPLETED\b/i.test(summary.innerText || '');

  return (
    /^order summary$/i.test(document.title) &&
    visible &&
    itemCount > 0 &&
    checkoutCompleted
  );
}, undefined, { timeout: renderTimeoutMs });
        renderWaitStatus = 'summary_content_rendered';
      } catch {
        renderWaitStatus = 'summary_render_timeout';
      }
      renderWaitMs = Math.min(Date.now() - waitStart, renderTimeoutMs);
    }
  } finally {
    page.off('response', recordSummaryResponse);
  }

  let navigationAfter = {
  url: '[unavailable]',
  title: '',
  bodyDataset: {},
  summaryFormPresent: false,
  headings: [],
  relevantMessages: [],
  javascriptResourceCount: 0,
  javascriptResources: [],
  renderState: {
    readyState: 'unavailable',
    bodyTextPresent: false,
    bodyTextLength: 0,
    scriptElementCount: 0,
    visibleHeadingCount: 0,
    visibleControlCount: 0
  },
  forms: { count: 0 },
  controls: []
};

let summaryEvidence = {
  url: '[unavailable]',
  title: '',
  bodyDataset: {},
  summaryState: summaryRouteDetected,
  summaryHeading: false,
  visibleSummaryHeading: false,
  summaryContainerVisible: false,
  summaryItemCount: 0,
  checkoutCompletedVisible: false,
  expectedFields: {
    provider: false,
    monthlyPrice: false,
    installationPrice: false
  },
  renderState: {
    readyState: 'unavailable',
    bodyTextPresent: false,
    visibleHeadingCount: 0,
    summaryContainerPresent: false,
    summaryContainerVisible: false,
    summaryItemCount: 0,
    summaryTextPresent: false,
    checkoutCompletedVisible: false
  }
};

// Post-navigation inspection is diagnostic only. Bound each evaluation so
// an empty or unloading iframe cannot hold the scenario runner indefinitely.
navigationAfter = await inspectWithTimeout(
  () => inspectCheckoutNavigation(checkoutFrame),
  1000,
  navigationAfter
);

summaryEvidence = await inspectWithTimeout(
  () => collectOrderSummaryEvidence(checkoutFrame, input),
  1000,
  summaryEvidence
);

const reached = hasVerifiedOrderSummary(summaryEvidence);
  if (summaryRouteDetected && !reached && renderWaitStatus === 'summary_render_timeout') {
    const renderState = summaryEvidence.renderState || {};
    renderWaitStatus = renderState.bodyTextPresent ||
      renderState.visibleHeadingCount > 0 || renderState.summaryContainerPresent
      ? 'timed_out_incomplete_summary'
      : 'timed_out_empty_summary';
  }
  summaryEvidence.renderWait = {
    status: reached ? 'verified' : renderWaitStatus,
    timeoutMs: summaryRouteDetected ? renderTimeoutMs : 0,
    waitedMs: renderWaitMs,
    domContentLoadedReached,
    networkIdleReached,
    summaryRouteDetected
  };
  summaryEvidence.routeResponses = routeResponses;

  return { navigationAfter, summaryEvidence, reached };
}

function hasVerifiedOrderSummary(evidence) {
  return Boolean(
    evidence?.summaryState === true &&
    evidence?.title === 'Order Summary' &&
    evidence?.summaryContainerVisible === true &&
    evidence?.summaryItemCount > 0 &&
    evidence?.checkoutCompletedVisible === true &&
    evidence?.expectedFields?.provider === true &&
    evidence?.expectedFields?.monthlyPrice === true &&
    evidence?.expectedFields?.installationPrice === true
  );
}


async function verifyOrderSummary(page) {
  const summaryFrame = page.frames().find(frame =>
    /\/allconnect-frame\/order-summary\/?$/i.test(frame.url())
  );

  if (!summaryFrame) {
    return {
      reached: false,
      finalOrderSubmitted: false
    };
  }

  const title = await summaryFrame.evaluate(
    () => document.title
  );

  const url = summaryFrame.url();
  const summary = summaryFrame.locator('.summary');
  const orderItem = summaryFrame.locator('.summary .item');

  try {
    await summary.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return {
      reached: false,
      title,
      url,
      summaryVisible: false,
      orderItemCount: 0,
      checkoutCompleted: false,
      finalOrderSubmitted: false
    };
  }

  const pageContent = await summary.innerText();

  const verified =
    title === 'Order Summary' &&
    /\/allconnect-frame\/order-summary\/?$/i.test(url) &&
    await orderItem.count() > 0 &&
    pageContent.includes('CHECKOUT_COMPLETED');

  return {
    reached: verified,
    title,
    url,
    summaryVisible: await summary.isVisible(),
    orderItemCount: await orderItem.count(),
    checkoutCompleted: pageContent.includes('CHECKOUT_COMPLETED'),
    finalOrderSubmitted: false
  };
}

async function verifyFinalOrderSummaryCheckpoint(page) {
  // The simulator's verified Order Summary is the final supported checkpoint.
  // A Place Order control is not guaranteed to exist on this destination, and
  // this demo must never infer a real order submission from a UI transition.
  const verification = await verifyOrderSummary(page);
  if (!verification.reached) {
    throw new Error('Order Summary was not verified at the final demo checkpoint.');
  }
  console.log('[VERIFIED] Order Summary reached. Stopping before any real order submission.');
  return {
    clicked: false,
    reached: true,
    orderSummaryReached: true,
    orderConfirmationReached: false,
    finalOrderSubmitted: false,
    confirmationReached: false,
    verification: 'verified_order_summary_safe_stop'
  };
}

async function fillPaymentField(checkoutFrame, selector, value, label) {
  const field = checkoutFrame.locator(selector);
  await field.waitFor({ state: 'visible', timeout: 10000 });
  const tagName = await field.evaluate(element => element.tagName.toLowerCase());
  if (tagName === 'select') {
    const options = await field.locator('option').evaluateAll(elements => elements.map(option => ({
      value: option.value,
      label: (option.label || option.textContent || '').trim()
    })));
    const target = String(value);
    const match = options.find(option => option.value === target || option.label === target) ||
      options.find(option => label.toLowerCase().includes('year') &&
        (option.value.endsWith(target.slice(-2)) || option.label.endsWith(target.slice(-2))));
    if (!match) throw new Error(`No matching ${label} option was found in the simulator.`);
    await selectFieldWithDelay(field, { value: match.value }, 'Demo Credit Check, Installation and Payment', label);
  } else {
    let inputValue = String(value);
    if (label.toLowerCase().includes('year')) {
      const maxLength = Number(await field.getAttribute('maxlength'));
      if (maxLength === 2) inputValue = inputValue.slice(-2);
    }
    await fillFieldWithDelay(field, inputValue, 'Demo Credit Check, Installation and Payment', label);
  }
  const actual = await field.inputValue();
  if (label.toLowerCase().includes('card number') || label.toLowerCase().includes('cvv')) {
    if (String(actual).replace(/\D/g, '') !== String(value).replace(/\D/g, '')) {
      throw createFieldActionError('Demo Credit Check, Installation and Payment', label, `The entered ${label} could not be verified.`);
    }
  } else {
    const expectedValue = label.toLowerCase().includes('year') && String(actual).length === 2
      ? String(value).slice(-2)
      : String(value);
    if (String(actual).trim().toLowerCase() !== expectedValue.trim().toLowerCase()) {
      throw createFieldActionError('Demo Credit Check, Installation and Payment', label, `The entered ${label} could not be verified.`);
    }
  }
  return field;
}

async function completeDemoCheckout(page, input) {
  const checkoutFrame = await getCheckoutFrame(page);
  const result = {
    creditCheck: { performed: false, approved: false, dataSource: 'synthetic-demo-values' },
    installation: { requested: input.installation.type, selected: null, verified: false, confirmed: false },
    payment: { performed: false, method: null, simulated: true },
    orderSummaryReached: false,
    placeOrderClicked: false,
    finalOrderSubmitted: false,
    orderSummaryVerification: null,
    orderConfirmationReached: false,
    orderConfirmationVerification: null,
    navigationInspection: null,
    placeOrderVerification: null,
  };


  if (input.accountHolder.ezEnroll === true || input.accountHolder.ezEnroll === false) {
    console.log('\n========================================');
    console.log('DEMO CREDIT CHECK');
    console.log('========================================');
    result.creditCheck = await runSimulatorCreditCheck(checkoutFrame, input);
  }

  console.log('\n========================================');
  console.log('DEMO INSTALLATION');
  console.log('========================================');


const selectedInstallation = await selectInstallationOption(
  checkoutFrame,
  input.installation.type
);

console.log(
  '[VERIFIED] Installation selected:',
  selectedInstallation
);

result.installation.selected = selectedInstallation;
result.installation.verified = true;

  // Standard shipping requires no installation date/time or installation disclosure.
  // For professional installation, the simulator requires both Read boxes plus date/time.
if (input.installation.type === 'professional_installation') {
  console.log('\nPROFESSIONAL INSTALLATION DISCLOSURES');

  // Actual portal selector: label.m-read input[type="checkbox"]
  const readBoxes = checkoutFrame.locator(
    'label.m-read input[type="checkbox"]'
  );

  const count = await readBoxes.count();

  if (count !== 2) {
    throw new Error(
      `Expected exactly 2 professional installation Read checkboxes, found ${count}.`
    );
  }

  // Acknowledge both professional installation disclosures.
  for (let i = 0; i < count; i++) {
    const checkbox = readBoxes.nth(i);

    await checkbox.waitFor({
      state: 'visible',
      timeout: 10000
    });

    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }

    if (!(await checkbox.isChecked())) {
      throw new Error(
        `Professional installation Read checkbox ${i + 1} was not checked.`
      );
    }

    console.log(
      `[VERIFIED] Professional installation Read ${i + 1}/${count}`
    );
  }

  // Select installation date.
  const installDate = checkoutFrame.getByLabel(
    'Install date',
    { exact: true }
  );

  const timeSelect = checkoutFrame.getByLabel(
    'Preferred time of day',
    { exact: true }
  );

  const tomorrow = new Date(Date.now() + 86400000)
    .toISOString()
    .slice(0, 10);

  await fillFieldWithDelay(installDate, tomorrow, 'Demo Credit Check, Installation and Payment', 'Install Date');

  // Select first available time option.
  if (await timeSelect.locator('option').count() > 1) {
    await selectFieldWithDelay(timeSelect, { index: 1 }, 'Demo Credit Check, Installation and Payment', 'Preferred Time');
  }

  console.log('[VERIFIED] Installation date and preferred time selected.');
  }
    // READ-ONLY DIAGNOSTIC: Inspect checkout controls before the safety stop.
  // This does not click buttons or submit forms.
  result.navigationInspection = await inspectCheckoutNavigation(checkoutFrame);

  const installationControl =
    result.navigationInspection.controls.find(
      control => control.text === 'Confirm Installation >'
    );

  console.log('\nCONFIRM INSTALLATION READ-ONLY INSPECTION:');
  console.log(JSON.stringify(
    installationControl || {
      found: false,
      reason: 'Visible Confirm Installation control was not found.'
    },
    null,
    2
  ));

  // STEP 1: CONFIRM THE SELECTED INSTALLATION OPTION.
  const confirmInstallationButton = checkoutFrame.getByRole(
  'button',
  { name: 'Confirm Installation >', exact: true }
);

  await confirmInstallationButton.waitFor({
    state: 'visible',
    timeout: 10000
  });

  if (!(await confirmInstallationButton.isEnabled())) {
    throw new Error('Confirm Installation button is disabled.');
  }

  console.log('[ACTION] Clicking Confirm Installation...');

  await confirmInstallationButton.click();

  // Record the click, but do not assume installation was confirmed.
result.installation.confirmationClicked = true;
result.installation.confirmed = false;

// Inspect the actual checkout state after the click.
result.navigationInspection = await inspectCheckoutNavigation(
  checkoutFrame
);

console.log('\nPOST-INSTALLATION NAVIGATION INSPECTION:');
console.log(JSON.stringify(
  result.navigationInspection,
  null,
  2
));

console.log(
  '[INSPECTION] Confirm Installation was clicked. ' +
  'The resulting state still needs verification.'
);

  // STEP 2: WAIT FOR THE FORWARD BUTTON.
  console.log('\nWaiting for the next Forward button...');

  const finalForwardButton = checkoutFrame.getByRole(
  'button',
  { name: 'Forward >', exact: true }
);
  await finalForwardButton.waitFor({
    state: 'visible',
    timeout: 20000
  });

  if (input.accountHolder.ezEnroll === false) {
    if (result.creditCheck.performed !== true || result.creditCheck.approved !== true) {
      throw new Error('Credit-only navigation requires a verified simulator approval.');
    }

    result.navigationInspection = await inspectCheckoutNavigation(checkoutFrame);
    const visibleCardFields = await checkoutFrame.locator(
      'input[aria-label="Card Number"], input[aria-label="Card Holder Name"], ' +
      'input[aria-label="CVV Code"], input[aria-label="Expiration month"], ' +
      'input[aria-label="Expiration year"]'
    ).evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length);

    if (
      visibleCardFields > 0 ||
      result.navigationInspection.headings.some(heading => /payment information/i.test(heading))
    ) {
      result.stoppedSafely = true;
      result.stopReason = 'Simulator exposed payment fields after credit approval; no card details were entered.';
      result.payment = {
        performed: false,
        method: null,
        fieldsInspected: true,
        cardDetailsEntered: false,
        forwardClicked: false,
        status: 'stopped_safely'
      };
      return result;
    }

    // Credit-approved / no-card scenarios still have a final Authorization
    // screen. Forward reaches that screen; it does NOT submit the order.
    const forwardControl = result.navigationInspection.controls.find(control =>
      control.text === 'Forward >'
    );
    if (
      !forwardControl ||
      forwardControl.type !== 'button' ||
      forwardControl.insideForm ||
      forwardControl.formActionPresent ||
      !(await finalForwardButton.isEnabled())
    ) {
      throw new Error('Credit-only Forward was not verified as a safe navigation control.');
    }

    await finalForwardButton.click({ noWaitAfter: true, timeout: 5000 });
    console.log('[ACTION] Credit-approved Forward clicked; waiting for final Authorization.');

    const submitOrder = checkoutFrame.locator('#submitOrder');
    await submitOrder.waitFor({ state: 'visible', timeout: 15000 });
    if (await submitOrder.count() !== 1 || !(await submitOrder.isEnabled())) {
      throw new Error('Final Authorization Submit Order control was not uniquely available.');
    }

    const finalReadGroup = checkoutFrame.locator('label.m-read input[type="checkbox"]');
    let finalReadIndex = -1;
    const finalReadDeadline = Date.now() + 15000;
    while (Date.now() < finalReadDeadline && finalReadIndex < 0) {
      finalReadIndex = await finalReadGroup.evaluateAll(elements => {
        const candidates = elements.map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            index,
            visible: style.display !== 'none' && style.visibility !== 'hidden' &&
              rect.width > 0 && rect.height > 0,
            checked: element.checked
          };
        }).filter(item => item.visible && !item.checked);
        return candidates.length ? candidates[candidates.length - 1].index : -1;
      });
      if (finalReadIndex < 0) await pause(200);
    }
    if (finalReadIndex < 0) {
      throw new Error('Final professional-installation Authorization Read checkbox was not found unchecked.');
    }

    const finalRead = finalReadGroup.nth(finalReadIndex);
    await finalRead.check();
    if (!(await finalRead.isChecked())) {
      throw new Error('Final professional-installation Authorization Read checkbox was not verified checked.');
    }
    console.log('[VERIFIED] Final professional-installation Authorization Read checkbox checked.');

    // Preserve the previously working Scenario 5 demo path: the scenario
    // already passes the demo-only validation, while this local environment
    // flag remains the explicit final-submit safety gate.
    if (process.env.ALLOW_DEMO_ORDER_SUBMISSION !== 'true') {
      throw new Error('Final Submit Order is locked unless ALLOW_DEMO_ORDER_SUBMISSION=true is set locally for the demo simulator.');
    }

    // The simulator may re-render the Authorization panel after Read is
    // checked. Reacquire the checkbox and Submit Order control, then wait for
    // the portal to enable submission. Do not click Forward or Submit twice.
    const finalSubmitControl = checkoutFrame.locator('#submitOrder');
    const submitReadyDeadline = Date.now() + 15000;
    let submitReady = false;

    while (Date.now() < submitReadyDeadline) {
      const finalReadState = await finalReadGroup.evaluateAll(elements => {
        const visible = elements.filter(element => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 && rect.height > 0;
        });
        return {
          visibleCount: visible.length,
          lastVisibleChecked: visible.length > 0
            ? visible[visible.length - 1].checked === true
            : false
        };
      }).catch(() => ({ visibleCount: 0, lastVisibleChecked: false }));

      const submitCount = await finalSubmitControl.count().catch(() => 0);
      const submitVisible = submitCount === 1 &&
        await finalSubmitControl.isVisible().catch(() => false);
      const submitEnabled = submitVisible &&
        await finalSubmitControl.isEnabled().catch(() => false);

      if (finalReadState.lastVisibleChecked && submitEnabled) {
        submitReady = true;
        break;
      }

      await pause(200);
    }

    if (!submitReady) {
      const state = await finalSubmitControl.evaluateAll(elements =>
        elements.map(element => ({
          disabled: element.disabled,
          visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        }))
      ).catch(() => []);
      throw new Error(
        'Final Authorization did not become ready for submission: ' +
        'the last visible Read checkbox must remain checked and exactly one Submit Order control must be enabled. ' +
        `Observed Submit Order controls: ${state.length}.`
      );
    }

    await finalSubmitControl.scrollIntoViewIfNeeded();
    console.log('[ACTION] Clicking #submitOrder on the final Authorization page...');

    // This is the single final-submit action. If it fails, preserve the open
    // browser for inspection rather than replaying a potentially dispatched order.
    try {
      await finalSubmitControl.click({ timeout: 15000, noWaitAfter: true });
    } catch (clickError) {
      const state = await checkoutFrame.locator('#submitOrder').evaluateAll(elements =>
        elements.map(element => ({
          disabled: element.disabled,
          visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        }))
      ).catch(() => []);
      console.error('[ERROR] Submit Order click failed. Safe control-state count:', state.length);
      throw new Error(`Final Submit Order click failed (${clickError.name || 'PlaywrightError'}).`);
    }
    console.log('[ACTION] Credit-approved demo Submit Order click dispatched; waiting for Order Summary.');
    await pause(1000);

console.log('[DEBUG] Browser state immediately after Submit Order:', {
  pageUrl: page.url(),
  pageTitle: await page.title().catch(() => 'Unavailable'),
  readyState: await page.evaluate(() => document.readyState).catch(() => 'Unavailable'),
  iframeCount: page.frames().length,
  frameUrls: page.frames().map(frame => frame.url())
});
    
let summaryFrame = null;
const summaryDeadline = Date.now() + 20000;

while (Date.now() < summaryDeadline && !summaryFrame) {
  summaryFrame = page.frames().find(frame =>
    /\/allconnect-frame\/order-summary\/?$/i.test(frame.url())
  ) || null;

  if (!summaryFrame) await pause(200);
}

console.log('[DEBUG] Order Summary frame detection:', {
  found: !!summaryFrame,
  frameUrls: page.frames().map(frame => frame.url())
});

if (!summaryFrame) {
  throw new Error(
    'Submit Order was clicked, but the Order Summary destination route was not reached.'
  );
}

console.log('[VERIFIED] Order Summary iframe detected.');

await summaryFrame.locator('.summary').waitFor({
  state: 'visible',
  timeout: 15000
});

console.log('[VERIFIED] Order Summary .summary element is visible.');

const summaryVerification = await verifyOrderSummary(page);

console.log('[DEBUG] Order Summary verification:', summaryVerification);

if (!summaryVerification.reached) {
  throw new Error(
    'Order Summary route appeared, but its final content could not be verified.'
  );
}

console.log('[VERIFIED] Order Summary content verified.');

const placeOrderResult = await verifyFinalOrderSummaryCheckpoint(page);

    if (placeOrderResult.reached !== true) {
      throw new Error('Order Summary safe-stop checkpoint was not verified.');
    }

    result.placeOrderClicked = false;
    result.placeOrderVerification = placeOrderResult;
    result.orderConfirmationReached = false;
result.orderConfirmationVerification = {
  reached: false,
  reason: 'The demo portal does not expose a separate real-order confirmation state.'
};
    result.orderSummaryVerification = { ...summaryVerification, finalOrderSubmitted: false, placeOrderClicked: false };
    result.orderSummaryReached = true;
    result.finalOrderSubmitted = false;
    result.installation.confirmed = false;
    result.payment = {
      performed: false,
      method: 'credit_approved_demo',
      fieldsInspected: false,
      cardDetailsEntered: false,
      forwardClicked: true,
      finalReadChecked: true,
      submitOrderClicked: true,
      status: 'order_summary_verified_safe_stop'
    };
    result.stoppedSafely = false;
    result.stopReason = 'Professional-installation Order Summary verified; no real order was submitted.';
    return result;
  }


  console.log('\n========================================');
  console.log('PREPARING PAYMENT FIELD INSPECTION');
  console.log('========================================');
  // STEP 3: Reach the payment disclosure screen. Some simulator states show
  // it immediately after Confirm Installation; others require one Forward.
  // Detect the actual screen first to avoid clicking Forward past the Read box.
  console.log('[WAIT] Checking whether the payment disclosure is already visible...');

  const paymentDisclosureText = checkoutFrame.getByText(
    /To confirm the card has sufficient funds/i
  );
  const paymentDisclosure = checkoutFrame
    .locator('.box.tinted')
    .filter({ has: paymentDisclosureText });

  let paymentDisclosureCount = await paymentDisclosure.count();

  if (paymentDisclosureCount === 0) {
    console.log('[ACTION] Payment disclosure not visible yet; clicking Forward once...');

    if (!(await finalForwardButton.isEnabled())) {
      throw new Error('Forward button is disabled before the payment disclosure screen.');
    }

    await finalForwardButton.click();
    console.log('[ACTION] Forward clicked. Waiting for payment disclosure...');

    await paymentDisclosureText.waitFor({ state: 'visible', timeout: 15000 });
    paymentDisclosureCount = await paymentDisclosure.count();
  }

  result.navigationInspection = await inspectCheckoutNavigation(checkoutFrame);

  console.log('\nPAYMENT DISCLOSURE SCREEN INSPECTION:');
  console.log(JSON.stringify(result.navigationInspection, null, 2));

  // 1. Acknowledge the payment-hold disclosure that appears on this screen.
  // Scope to its own disclosure box so hidden/stale checkboxes elsewhere in
  // the checkout iframe cannot cause an incorrect element count.
  const paymentRead = paymentDisclosureCount === 1
    ? paymentDisclosure.locator('label.m-read input[type="checkbox"]')
    : checkoutFrame.locator('label.m-read input[type="checkbox"]').filter({ has: paymentDisclosureText });

  if (await paymentRead.count() !== 1) {
    throw new Error('Expected exactly one payment sufficient-funds Read checkbox.');
  }

  await paymentRead.waitFor({ state: 'visible', timeout: 15000 });

  if (!(await paymentRead.isChecked())) {
    await paymentRead.check();
  }

  if (!(await paymentRead.isChecked())) {
    throw new Error('Payment sufficient-funds Read checkbox was not checked.');
  }

  console.log('[VERIFIED] Payment sufficient-funds Read checkbox checked.');

  // 2. Select the option by its visible label rather than assuming the
  // simulator's internal radio-group name.
  const addCardRadio = checkoutFrame.getByLabel(
    'Add a new credit card',
    { exact: true }
  );

  if (await addCardRadio.count() !== 1) {
    throw new Error(
      `Expected exactly one labelled Add a new credit card option, found ${await addCardRadio.count()}.`
    );
  }

  await addCardRadio.waitFor({ state: 'visible', timeout: 10000 });

  if (!(await addCardRadio.isChecked())) {
    await addCardRadio.check();
  }

  if (!(await addCardRadio.isChecked())) {
    throw new Error('Add a new credit card option could not be selected.');
  }

  console.log('[VERIFIED] Add a new credit card selected.');

  // 3. Enable the secure fields.
  const editSecureFields = checkoutFrame.getByRole(
    'button',
    { name: 'Edit Secure Fields', exact: true }
  );

  await editSecureFields.waitFor({
    state: 'visible',
    timeout: 10000
  });

  await editSecureFields.click();

  console.log('[ACTION] Edit Secure Fields clicked.');

  // 4. Select the card network from scenario data, then fill only masked
  // synthetic card details delivered through the JWE-protected runtime input.
  const cardType = checkoutFrame.getByLabel(/^Card Type:?$/i);
  await cardType.waitFor({ state: 'visible', timeout: 10000 });
  const requestedCardType = input.paymentOptions?.cardType;
  if (!['Visa', 'MasterCard', 'American Express', 'Discover'].includes(requestedCardType)) {
    throw new Error('A supported card type must be supplied in paymentOptions.cardType.');
  }
  const cardTypeOptions = await cardType.locator('option').evaluateAll(options =>
    options.map(option => ({ value: option.value, label: (option.label || option.textContent || '').trim() }))
  );
  const selectedCardType = cardTypeOptions.find(option =>
    option.label.toLowerCase() === requestedCardType.toLowerCase() ||
    option.value.toLowerCase() === requestedCardType.toLowerCase()
  );
  if (!selectedCardType) throw new Error(`Requested card type is not available: ${requestedCardType}.`);
  await selectFieldWithDelay(cardType, { value: selectedCardType.value }, 'Demo Credit Check, Installation and Payment', 'Card Type');
  if ((await cardType.locator('option:checked').textContent()).trim().toLowerCase() !== requestedCardType.toLowerCase()) {
    throw createFieldActionError('Demo Credit Check, Installation and Payment', 'Card Type', 'The entered Card Type could not be verified.');
  }
  console.log(`[VERIFIED] Card type selected: ${requestedCardType}.`);

  let sensitiveData = await getFreshSensitiveData(input);
  const payment = sensitiveData.payment;
  if (!payment) throw new Error('EZ-Enroll payment details are missing from the encrypted input.');

  const cardNumberField = checkoutFrame.getByLabel(/^Card Number:?$/i);
  const cardHolderField = checkoutFrame.getByLabel(/^Card Holder Name:?$/i);
  const cvvField = checkoutFrame.getByLabel(/^CVV Code:?$/i);
  let expiryMonthField = checkoutFrame.getByLabel(/^Expiration month:?$/i);
  let expiryYearField = checkoutFrame.getByLabel(/^Expiration year:?$/i);
  if (await expiryMonthField.count() === 0) expiryMonthField = checkoutFrame.locator('input[placeholder="mm"]');
  if (await expiryYearField.count() === 0) expiryYearField = checkoutFrame.locator('input[placeholder="yyyy"]');
  for (const [field, label] of [[cardNumberField, 'Card Number'], [cardHolderField, 'Card Holder Name'], [cvvField, 'CVV Code'], [expiryMonthField, 'Expiration month'], [expiryYearField, 'Expiration year']]) {
    await field.waitFor({ state: 'visible', timeout: 10000 });
  }
  await fillFieldWithDelay(cardNumberField, payment.cardNumber, 'Demo Credit Check, Installation and Payment', 'Card Number');
  await fillFieldWithDelay(cardHolderField, payment.cardHolderName, 'Demo Credit Check, Installation and Payment', 'Card Holder Name');
  await fillFieldWithDelay(cvvField, payment.cvv, 'Demo Credit Check, Installation and Payment', 'CVV Code');
  await fillFieldWithDelay(expiryMonthField, payment.expirationMonth, 'Demo Credit Check, Installation and Payment', 'Expiration Month');
  await fillFieldWithDelay(expiryYearField, payment.expirationYear, 'Demo Credit Check, Installation and Payment', 'Expiration Year');

  // Verify each required card field is populated without logging its value.
  const populatedPaymentFieldCount = await Promise.all([
    cardNumberField, cardHolderField, cvvField, expiryMonthField, expiryYearField
  ].map(async field => (await field.inputValue()).trim() !== '')).then(values => values.filter(Boolean).length);
  if (populatedPaymentFieldCount !== 5) {
    throw new Error('One or more required simulator payment fields remain empty.');
  }

  // The billing-address choice is non-sensitive scenario data.
  const billingRadios = checkoutFrame.locator('input[type="radio"][name="billing"]');
  if (await billingRadios.count() !== 2) throw new Error('Expected Yes/No billing-address radio options.');
  const billingIndex = input.paymentOptions.billingAddressSameAsService ? 0 : 1;
  const billingChoice = billingRadios.nth(billingIndex);
  await billingChoice.check();
  if (!(await billingChoice.isChecked())) throw new Error('Billing-address choice could not be verified.');
  console.log(`[VERIFIED] Billing address same as service address: ${input.paymentOptions.billingAddressSameAsService ? 'Yes' : 'No'}.`);

  const paymentForward = checkoutFrame.locator('input.cbtn[value="Forward >"], #forward').first();
  await paymentForward.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await paymentForward.isEnabled())) throw new Error('Payment Forward button is disabled.');

  // Re-check the seven-minute JWE window immediately before advancing.
  sensitiveData = await getFreshSensitiveData(input);
  const lastPayment = sensitiveData.payment;
  await fillFieldWithDelay(cardNumberField, lastPayment.cardNumber, 'Demo Credit Check, Installation and Payment', 'Card Number');
  await fillFieldWithDelay(cardHolderField, lastPayment.cardHolderName, 'Demo Credit Check, Installation and Payment', 'Card Holder Name');
  await fillFieldWithDelay(cvvField, lastPayment.cvv, 'Demo Credit Check, Installation and Payment', 'CVV Code');
  await fillFieldWithDelay(expiryMonthField, lastPayment.expirationMonth, 'Demo Credit Check, Installation and Payment', 'Expiration Month');
  await fillFieldWithDelay(expiryYearField, lastPayment.expirationYear, 'Demo Credit Check, Installation and Payment', 'Expiration Year');

  console.log('[VERIFIED] Synthetic test-card fields were populated. Card values were not logged.');
  await paymentForward.click();
  result.payment.forwardClicked = true;
  result.payment.performed = true;

  // The portal reveals the final authorization Read checkbox after Forward.
  // Do not blindly use .last(): earlier disclosure checkboxes can remain in
  // the iframe DOM. Find the last VISIBLE, UNCHECKED Read checkbox instead.
  const finalReadGroup = checkoutFrame.locator(
    'label.m-read input[type="checkbox"]'
  );
  let finalReadIndex = -1;
  const finalReadDeadline = Date.now() + 15000;

  // The final disclosure can render asynchronously after Payment Forward.
  // Poll its actual visible/checked state without clicking Forward again.
  while (Date.now() < finalReadDeadline && finalReadIndex < 0) {
    finalReadIndex = await finalReadGroup.evaluateAll(elements => {
      const visibleUnchecked = elements
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            index,
            visible: style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 && rect.height > 0,
            checked: element.checked
          };
        })
        .filter(item => item.visible && !item.checked);

      return visibleUnchecked.length
        ? visibleUnchecked[visibleUnchecked.length - 1].index
        : -1;
    });

    if (finalReadIndex < 0) await pause(200);
  }

  if (finalReadIndex < 0) {
    throw new Error(
      'Final authorization Read checkbox was not found as a visible unchecked checkbox after Payment Forward.'
    );
  }

  const finalRead = finalReadGroup.nth(finalReadIndex);
  await finalRead.check();
  if (!(await finalRead.isChecked())) {
    throw new Error('Final authorization Read checkbox could not be verified after checking it.');
  }
  console.log('[VERIFIED] Final authorization Read checkbox checked.');

  if (input.execution?.submitDemoOrder !== true || process.env.ALLOW_DEMO_ORDER_SUBMISSION !== 'true') {
    throw new Error('Final Submit Order is locked unless the scenario and local demo-only environment flag both opt in.');
  }

  const submitOrder = checkoutFrame.locator(
    'input[type="button"][value="Submit Order"], input[type="submit"][value="Submit Order"], button:has-text("Submit Order")'
  );
  await submitOrder.waitFor({ state: 'visible', timeout: 15000 });
  if (await submitOrder.count() !== 1) throw new Error('Expected exactly one Submit Order control.');
  if (!(await submitOrder.isEnabled())) throw new Error('Submit Order control is disabled.');

  // Click once, then wait for the checkout iframe to reach the destination route.
  await submitOrder.click({ noWaitAfter: true });
  console.log('[ACTION] Submit Order clicked in the explicitly enabled demo scenario.');

  let summaryFrame = null;
  const summaryDeadline = Date.now() + 20000;
  while (Date.now() < summaryDeadline && !summaryFrame) {
    summaryFrame = page.frames().find(frame =>
      /\/allconnect-frame\/order-summary\/?$/i.test(frame.url())
    ) || null;
    if (!summaryFrame) await pause(200);
  }

  if (!summaryFrame) {
    throw new Error('Submit Order was clicked, but the Order Summary destination route was not reached.');
  }

  await summaryFrame.locator('.summary').waitFor({
    state: 'visible',
    timeout: 15000
  });

  const summaryVerification = await verifyOrderSummary(page);
  if (!summaryVerification.reached) {
    throw new Error('Order Summary route appeared, but its final content could not be verified.');
  }
  const placeOrderResult = await verifyFinalOrderSummaryCheckpoint(page);

  if (!placeOrderResult.reached) {
    throw new Error('Order Summary safe-stop checkpoint was not verified.');
  }

  result.placeOrderClicked = false;
  result.placeOrderVerification = placeOrderResult;
  if (input.sensitiveData?.payment) {
    for (const key of Object.keys(input.sensitiveData.payment)) input.sensitiveData.payment[key] = '';
  }

  result.orderSummaryReached = true;
  result.orderSummaryVerification = {
    ...summaryVerification,
    finalOrderSubmitted: false,
    placeOrderClicked: false
  };
  result.finalOrderSubmitted = false;
  result.payment = {
    performed: false, method: 'simulator_test_card', simulated: true, fieldsInspected: true,
    cardDetailsEntered: true, forwardClicked: true, finalReadChecked: true,
    submitOrderClicked: true, status: 'order_summary_verified_safe_stop'
  };
  result.stoppedSafely = false;
  result.stopReason = 'Simulator Submit Order transition reached a verified Order Summary; no real order was submitted.';
  return result;

}
async function runAutomation(input) {
  validateInput(input, { requireSensitiveData: true });

  const cfg = getConfig();

  const reportStartTime = Date.now();

  let browser;
  let context;
  let page;
  let keepBrowserOpen = false;
  let automationTimedOut = false;
  let automationTimer = null;
  let accountHolderReport;
  let accountHolderForwardReport;
  let installationReport;

  const executionReport = {
    runId: /^[a-f0-9-]{36}$/i.test(input.execution?.runId || '') ? input.execution.runId : crypto.randomUUID(),
    startedAt: new Date(reportStartTime).toISOString(),
    finishedAt: null,
    durationMs: null,
    status: 'started',

    mode: input.execution?.mode || 'demo',
provider: input.plan?.provider || null,
customerType: input.qualification?.customerType || null,

plan: {
  speedMbps: Number.parseInt(input.plan?.speed, 10) || null,
      term: input.plan?.term || null,
      monthlyPrice: input.plan?.monthlyPrice ?? null,
      installationPrice: input.plan?.installationPrice ?? null
    },

    customization: {
      broadbandFactLabels: input.checkout?.broadbandFactLabels || null,
      broadbandFactLabelsRead:
        input.checkout?.broadbandFactLabelsRead === true,
      equipment: input.checkout?.equipment || null,
      nowTv: input.checkout?.nowTv === true
    },

    accountHolderValidation: null,
    accountHolderForward: null,
    installation: null,
    creditCheck: null,
    payment: null,
    orderSummaryReached: false,
    placeOrderClicked: false,
    finalOrderSubmitted: false,
    orderSummaryVerification: null,
    orderConfirmationReached: false,
    orderConfirmationVerification: null,
    placeOrderVerification: null,
    navigationInspection: null,
    navigationAfterForward: null,
    stopReason: null,

    summary: null,

    safetyCheckpoint: {
      creditCheckPerformed: false,
      paymentPerformed: false,
      installationConfirmed: false,
      finalOrderSubmitted: false
    },
    steps: [],
    error: null
  };

  let activeExecutionStep = null;

  function startExecutionStep(name) {
    const now = Date.now();

    if (activeExecutionStep) {
      activeExecutionStep.record.status = 'completed';
      activeExecutionStep.record.finishedAt = new Date(now).toISOString();
      activeExecutionStep.record.durationMs =
        now - activeExecutionStep.startedAt;
    }

    const record = {
      name,
      status: 'running',
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      durationMs: null
    };

    executionReport.steps.push(record);

    activeExecutionStep = {
      record,
      startedAt: now
    };
  }

  function finishExecutionStep(status) {
    if (!activeExecutionStep) return;

    const now = Date.now();

    activeExecutionStep.record.status = status;
    activeExecutionStep.record.finishedAt = new Date(now).toISOString();
    activeExecutionStep.record.durationMs =
      now - activeExecutionStep.startedAt;

    activeExecutionStep = null;
  }
  try {
    startExecutionStep('Portal Login');
    browser = await launchBrowser(cfg.headless, { timeout: cfg.browserLaunchTimeoutMs });
    automationTimer = setTimeout(() => {
      automationTimedOut = true;
      if (context) context.close().catch(() => {});
      if (browser) browser.close().catch(() => {});
    }, cfg.maxRuntimeMs);
    if (typeof automationTimer.unref === 'function') automationTimer.unref();
    // Browser retention is opt-in for local interactive inspection only.
    if (
      input.execution?.mode === 'demo' &&
      process.env.KEEP_BROWSER_OPEN === 'true' &&
      cfg.headless === false
    ) {
      keepBrowserOpen = true;
    }
    context = await browser.newContext({
  viewport: {
    width: 1440,
    height: 900
  }
});
    page = await context.newPage();
    page.setDefaultTimeout(cfg.actionTimeoutMs);
    page.setDefaultNavigationTimeout(cfg.navigationTimeoutMs);

    console.log('\nOpening AllConnect portal...');

    await navigateWithRecovery(page, cfg.portalUrl, { timeout: 30000, attempts: 2 });

        console.log('Starting authentication...');
    await login(page, cfg);

    finishExecutionStep('completed');

// STEP 1: BASIC INFORMATION.
startExecutionStep('Basic Information');
console.log('\n--- BASIC INFORMATION ---');

    await inspectBasicInformation(page);

    console.log('Filling Basic Information from input.customer...');
    await fillBasicInformation(page, input.customer);

    const basicInfoForward = page.locator('#basicInfoForward');

    await basicInfoForward.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await basicInfoForward.click();
    await page.locator('#addressFoundForward').waitFor({
      state: 'visible',
      timeout: 15000
    });

    // STEP 2: ADDRESS VALIDATION.
    startExecutionStep('Address Validation');
    await inspectPage(
      page,
      'VALID ADDRESS PAGE',
      'next-page-inspection.png'
    );

    const addressForward = page.locator('#addressFoundForward');

    await addressForward.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await addressForward.click();
    await page.locator(
      '#selection_display #BOOL_New_DF_Scripted_Qual_CL_11, ' +
      '#selection_display #BOOL_Transfer_DF_Scripted_Qual_CL_11'
    ).first().waitFor({
      state: 'visible',
      timeout: 15000
    });

    // STEP 3: QUALIFICATION.
    startExecutionStep('Customer Qualification');
    await inspectPage(
      page,
      'QUALIFICATION PAGE',
      'following-page-inspection.png'
    );

    console.log('\nSelecting customer type from input...');

    const qualificationSelector =
      input.qualification.customerType === 'new'
        ? '#selection_display #BOOL_New_DF_Scripted_Qual_CL_11'
        : '#selection_display #BOOL_Transfer_DF_Scripted_Qual_CL_11';

    const qualificationRadio = page.locator(
      qualificationSelector
    );

    await qualificationRadio.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await qualificationRadio.check();

    if (!(await qualificationRadio.isChecked())) {
      throw new Error(
        'Customer qualification selection could not be verified.'
      );
    }

    console.log(
      'Customer type selected:',
      input.qualification.customerType
    );

    const qualificationForward = page.locator(
      '#qualificationForward'
    );

    await qualificationForward.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await qualificationForward.click();
    await page.locator(
      'a[data-ac-href*="CategoryName=INTERNET"]'
    ).waitFor({
      state: 'visible',
      timeout: 15000
    });

    // STEP 4: RECOMMENDATIONS.
    startExecutionStep('Recommendations');
    await inspectPage(
      page,
      'RECOMMENDATIONS PAGE',
      'recommendations-inspection.png'
    );

    // STEP 5: INTERNET CATEGORY.
    startExecutionStep('Internet Category');
    console.log('\nOpening Internet category...');

    await openInternetOffers(page);

    // STEP 6: INTERNET OFFERS.
    startExecutionStep('Internet Offers');
    await inspectPage(
      page,
      'INTERNET OFFERS PAGE',
      'internet-offers-inspection.png'
    );

    // STEP 7: FIND PLAN FROM INPUT.
    startExecutionStep('Plan Selection');
    console.log('\n--- FINDING REQUESTED PLAN ---');
    console.log(JSON.stringify(input.plan, null, 2));

    const matchingPlan = await findProviderPlans(
      page,
      input.plan
    );

    console.log('\nSelected plan candidate:');
    console.log(JSON.stringify(matchingPlan, null, 2));

    const selectedButton = page.locator(
      'input.ViewDetailsBtn'
    ).nth(matchingPlan.buttonIndex);

    await selectedButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const selectedCard = selectedButton.locator(
      'xpath=ancestor::*[contains(@class,"singleProductContent")][1]'
    );

    const selectedCardText = await selectedCard.innerText();

    const selectedHiddenJson = await selectedCard.locator(
      '.singleHiddenJson'
    ).getAttribute('value');

    let selectedPlanData;

    try {
      selectedPlanData = JSON.parse(selectedHiddenJson || '{}');
    } catch {
      throw new Error(
        'Could not parse the selected plan hidden JSON.'
      );
    }

    if (!planMatches({
      text: selectedCardText,
      hiddenJson: selectedHiddenJson
    }, input.plan)) {
      throw new Error(
        'Final plan verification failed. The plan will not be opened.'
      );
    }

    console.log('\nVerified plan:');
    console.log('Provider:', selectedPlanData.providerName);
    console.log('Product:', selectedPlanData.productname);
    console.log('Recurring price:', selectedPlanData.recuring);
    console.log('Button ID:', matchingPlan.buttonId);

    // STEP 8: OPEN PLAN DETAILS.
    startExecutionStep('Open Plan Details');
    console.log('\nOpening the matching plan details...');

    await selectedButton.click();
    await page.locator('#AddToOrderBtn2').waitFor({
      state: 'visible',
      timeout: 15000
    });

    await inspectPage(
      page,
      'SELECTED PLAN DETAILS',
      'providerxx-plan-details.png'
    );

    // STEP 9: VERIFY PLAN DETAILS.
    startExecutionStep('Plan Verification');
    const detailText = await page.locator('body').innerText();

    if (!speedMatches(detailText, input.plan.speed)) {
      throw new Error(
        'Plan details page does not show the requested speed.'
      );
    }

    if (!termMatches(detailText, input.plan.term)) {
      throw new Error(
        'Plan details page does not show the requested contract term.'
      );
    }

    const monthlyPriceText = new RegExp(
      `BASE MONTHLY PRICE:\\s*\\$?${Number(
        input.plan.monthlyPrice
      ).toFixed(2)}`,
      'i'
    );

    const installationPriceText = new RegExp(
      `BASE INSTALLATION PRICE:\\s*\\$?${Number(
        input.plan.installationPrice
      ).toFixed(2)}`,
      'i'
    );

    if (!monthlyPriceText.test(detailText)) {
      throw new Error(
        'Plan details monthly price does not match input.plan.monthlyPrice.'
      );
    }

    if (!installationPriceText.test(detailText)) {
      throw new Error(
        'Plan details installation price does not match input.plan.installationPrice.'
      );
    }

    console.log('Plan speed verified.');
    console.log('Plan term verified.');
    console.log('Monthly price verified.');
    console.log('Installation price verified.');

    // STEP 10: ADD TO ORDER.
    startExecutionStep('Add Plan to Order');
    const addToOrderButton = page.locator('#AddToOrderBtn2');

    await addToOrderButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const addToOrderValue = await addToOrderButton.inputValue();

    if (!/Add to Order/i.test(addToOrderValue)) {
      throw new Error('Add to Order button could not be verified.');
    }

    console.log('\nAdding verified plan to order...');
    await addToOrderButton.click();
    await page.locator('#checkoutItems').waitFor({
      state: 'visible',
      timeout: 15000
    });

    // STEP 11: VERIFY CART.
    startExecutionStep('Cart Verification');
    console.log('\n--- SHOPPING CART VERIFICATION ---');

    const cartText = await page.locator('body').innerText();

    console.log('Cart contents inspected; raw customer details omitted from logs.');

    await saveDiagnosticScreenshot(page, 'providerxx-plan-added-to-order.png');

    if (
      !speedMatches(cartText, input.plan.speed) ||
      !termMatches(cartText, input.plan.term) ||
      !monthlyPriceText.test(cartText)
    ) {
      throw new Error(
        'Cart verification failed. Checkout will not be opened.'
      );
    }

    console.log('Requested plan verified in cart.');

    // STEP 12: OPEN CHECKOUT.
    startExecutionStep('Open Checkout');
    const checkoutButton = page.locator('#checkoutItems');

    await checkoutButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const checkoutValue = await checkoutButton.inputValue();

    if (!/Checkout/i.test(checkoutValue)) {
      throw new Error('Checkout button could not be verified.');
    }

    console.log('\nOpening checkout...');
    await checkoutButton.click();
    // The checkout is embedded in an iframe; wait for its actual readiness.
    await getCheckoutFrame(page);

    // STEP 13: INSPECT CHECKOUT.
    startExecutionStep('Checkout Inspection');
    await inspectCheckout(page);
    await inspectProviderCheckoutFrame(page);

    // STEP 14: ADVANCE TO PRODUCT CUSTOMIZATION.
    startExecutionStep('Advance to Product Customization');
    await advanceProviderCheckout(page);

    // STEP 15: INSPECT PRODUCT CUSTOMIZATION.
    startExecutionStep('Product Customization Inspection');
    await inspectProviderCustomizations(page);

    // STEP 16: APPLY INPUT-BASED CUSTOMIZATION.
    startExecutionStep('Apply Customizations');
    await completeProviderCustomizations(page, input);


    // STEP 17: ACCOUNT HOLDER CONTACT + VALIDATION.
    startExecutionStep('Account Holder Validation');
    accountHolderReport = await inspectAccountHolderPage(
      page,
      input
    );

    // STEP 17A: AUTOMATIC FORWARD AFTER VALIDATION.
    startExecutionStep('Account Holder Forward');
   accountHolderForwardReport =
  await advanceAccountHolderToInstallation(
    page,
    accountHolderReport,
    input
  );

executionReport.accountHolderValidation = {
  matched: accountHolderReport.counts.MATCHED,
  unresolved: accountHolderReport.counts.UNRESOLVED,
  mismatch: accountHolderReport.counts.MISMATCH
};

executionReport.accountHolderForward = {
  forwardClicked: accountHolderForwardReport.forwardClicked,
  step3Reached: accountHolderForwardReport.step3Reached
};

    console.log('\nACCOUNT HOLDER FORWARD REPORT');
    console.log(
      JSON.stringify(accountHolderForwardReport, null, 2)
    );

    const checkoutFrame = await getCheckoutFrame(page);


    console.log('\nINSTALLATION & PAYMENT CONTROL INSPECTION');

console.log(
  await checkoutFrame.locator('input, select, textarea, button').evaluateAll(elements =>
    elements.map(element => ({
      tag: element.tagName,
      type: element.getAttribute('type'),
      checked: element.checked,
      disabled: element.disabled,
      visible: !!(
        element.offsetWidth ||
        element.offsetHeight ||
        element.getClientRects().length
      ),
      text: element.tagName === 'BUTTON' && ['Forward >', 'Forward', 'Confirm Installation >'].includes(element.innerText.trim())
        ? element.innerText.trim()
        : ''
    }))
  )
);

    console.log('\nInstallation and payment page text omitted from diagnostics.');
    // STEP 18: COMPLETE THE LOCALLY SIMULATED CREDIT / INSTALL / PAYMENT FLOW.
    startExecutionStep('Demo Credit Check, Installation and Payment');
    const demoCheckoutResult = await completeDemoCheckout(page, input);
    keepBrowserOpen = process.env.KEEP_BROWSER_OPEN === 'true' && cfg.headless === false;

    executionReport.creditCheck = demoCheckoutResult.creditCheck;
    executionReport.installation = demoCheckoutResult.installation;
    executionReport.payment = demoCheckoutResult.payment;
    executionReport.orderSummaryReached = demoCheckoutResult.orderSummaryReached;
    executionReport.orderSummaryVerification = demoCheckoutResult.orderSummaryVerification;
    executionReport.orderConfirmationReached = demoCheckoutResult.orderConfirmationReached === true;
    
    executionReport.orderConfirmationVerification = demoCheckoutResult.orderConfirmationVerification || null;
    executionReport.placeOrderClicked = demoCheckoutResult.placeOrderClicked === true;
    executionReport.finalOrderSubmitted = demoCheckoutResult.finalOrderSubmitted === true;
    executionReport.placeOrderVerification = demoCheckoutResult.placeOrderVerification || null;
    executionReport.navigationInspection = demoCheckoutResult.navigationInspection;
    executionReport.navigationAfterForward = demoCheckoutResult.navigationAfterForward;
    executionReport.stopReason = demoCheckoutResult.stopReason || null;

    executionReport.safetyCheckpoint.creditCheckPerformed = demoCheckoutResult.creditCheck.performed === true && demoCheckoutResult.creditCheck.simulated !== true;
    executionReport.safetyCheckpoint.paymentPerformed = demoCheckoutResult.payment.performed === true && demoCheckoutResult.payment.simulated !== true;
    executionReport.safetyCheckpoint.installationConfirmed = demoCheckoutResult.installation.confirmed;
    executionReport.safetyCheckpoint.finalOrderSubmitted = demoCheckoutResult.finalOrderSubmitted === true;

    console.log('\nDEMO CHECKOUT RESULT');
    console.log(JSON.stringify(demoCheckoutResult, null, 2));


    console.log('\nFINAL DEMO STATUS');
    console.log(
      demoCheckoutResult.creditCheck.performed
        ? '[COMPLETED] Credit check simulated locally.'
        : '[SKIPPED] Credit check not required or not performed.'
    );
    console.log(
  demoCheckoutResult.installation.confirmed
    ? '[VERIFIED] Installation confirmation verified.'
    : '[NOT CONFIRMED] Installation confirmation was not verified.'
);
    console.log(
      demoCheckoutResult.payment.cardDetailsEntered
        ? '[VERIFIED] Synthetic test-card fields entered and payment step advanced.'
        : demoCheckoutResult.payment.fieldsInspected
          ? '[INSPECTED] Payment fields inspected.'
          : '[SKIPPED] Payment fields not inspected.'
    );

    if (demoCheckoutResult.orderSummaryReached === true) {
      console.log('[COMPLETED] Verified Order Summary reached. No real order was submitted.');
      finishExecutionStep('completed');
      executionReport.status = 'completed';
    } else if (demoCheckoutResult.stoppedSafely) {
      console.log(
  '[INCOMPLETE] Order Summary has not been verified.'
);
      finishExecutionStep('stopped_safely');
      executionReport.status = 'stopped_safely';
    } else {
      throw new Error('Checkout ended without reaching Order Summary or a safe stop.');
    }

    console.log('\nAUTOMATION CHECKPOINT:', executionReport.status);


  } catch (caughtError) {
  const error = automationTimedOut
    ? Object.assign(new Error('Automation exceeded the configured maximum runtime.'), { code: 'AUTOMATION_TIMEOUT' })
    : caughtError;
  finishExecutionStep('failed');
  executionReport.status = 'failed';
  if (error.creditCheckResult) {
    executionReport.creditCheck = error.creditCheckResult;
    executionReport.safetyCheckpoint.creditCheckPerformed = error.creditCheckResult.simulated !== true;
  }
  executionReport.error = await captureFailureDiagnostics(page, error, {
    step: executionReport.steps.find(step => step.status === 'failed')?.name || null,
    creditCheckStage: getCreditCheckStageForError(error),
    screenshotPath: 'automation-error.png'
  });
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error.failureDetails = executionReport.error.failure?.fieldFailure || null;
  }

  console.error('\nAutomation failed:', executionReport.error.failure.type,
    `(step: ${executionReport.error.failure.step || 'unknown'})`);

    throw error;

      } finally {
    if (automationTimer) clearTimeout(automationTimer);
    executionReport.finishedAt = new Date().toISOString();
    executionReport.durationMs = Date.now() - reportStartTime;

    const steps = executionReport.steps || [];

    const completedSteps = steps.filter(
      step => step.status === 'completed'
    ).length;

    const failedSteps = steps.filter(
      step => step.status === 'failed'
    ).length;

    const lastStep = steps.length > 0
      ? steps[steps.length - 1]
      : null;

    const failedStep = steps.find(
      step => step.status === 'failed'
    );

    executionReport.summary = {
      status: executionReport.status,

      totalRecordedSteps: steps.length,
      completedSteps,
      failedSteps,

      lastReachedStep: lastStep
        ? lastStep.name
        : null,

      failedStep: failedStep
        ? failedStep.name
        : null,

      workflowCompleted:
        executionReport.status === 'completed',

      orderSummaryReached: executionReport.orderSummaryReached === true,
      placeOrderClicked: executionReport.placeOrderClicked === true,
      orderConfirmationReached: executionReport.orderConfirmationReached === true,
      finalOrderSubmitted: executionReport.safetyCheckpoint.finalOrderSubmitted === true,

      safety: {
        creditCheckPerformed:
          executionReport.safetyCheckpoint.creditCheckPerformed,

        paymentPerformed:
          executionReport.safetyCheckpoint.paymentPerformed,

        installationConfirmed:
          executionReport.safetyCheckpoint.installationConfirmed,

        finalOrderSubmitted:
          executionReport.safetyCheckpoint.finalOrderSubmitted
      }
    };

    try {
      saveExecutionReport(executionReport);
    } catch (reportError) {
      console.error('\nCould not save execution report (report_write_error).');
    }


if (keepBrowserOpen) {
  console.log('\n========================================');

  if (executionReport.orderSummaryReached === true) {
    console.log('FINAL ORDER SUMMARY DISPLAYED');
    console.log('========================================');
    console.log('CHECKOUT_COMPLETED: VERIFIED');
  } else if (executionReport.status === 'stopped_safely') {
  console.log('SAFE STOP - INSTALLATION CONFIRMATION NOT PERFORMED');
  console.log('========================================');
  console.log('INSTALLATION_OPTION_VERIFIED:',
    executionReport.installation?.verified === true ? 'YES' : 'NO');
  console.log('INSTALLATION_CONFIRMATION_CLICKED: NO');
  console.log('PAYMENT_PERFORMED: NO');
  console.log('FINAL_ORDER_SUBMITTED: NO');
  console.log('ORDER_SUMMARY_REACHED:',
    executionReport.orderSummaryReached === true ? 'YES' : 'NO');
} else {
    console.log('BROWSER LEFT OPEN FOR INSPECTION');
    console.log('========================================');
    console.log('Order Summary has not been verified.');
  }

  console.log('Browser will remain open for inspection.');
  console.log('Close the browser manually when finished.');

} else {
  if (context) {
    await context.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
}

  }

  return executionReport;
}

// ============================================================
// EXPORT AND LOCAL DEMO RUNNER
// ============================================================
// API integration:
// const { runAutomation } = require('./main');
// await runAutomation(apiPayload);

module.exports = {
  runAutomation,
  validateInput,
  sanitizeExecutionReport,
  getCreditCheckStageForError,
  runSimulatorCreditCheck,
  collectOrderSummaryEvidence,
  hasVerifiedOrderSummary,
  clickForwardAndVerifyOrderSummary,
  selectInstallationOption,
  completeDemoCheckout,
  openInternetOffers
};

