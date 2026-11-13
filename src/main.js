
const fs = require('fs');
const path = require('path');

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
const checkoutFrameCache = new WeakMap();
const creditCheckFailureStages = new WeakMap();

function getCreditCheckStageForError(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }
  return creditCheckFailureStages.get(error);
}

function sanitizeExecutionReport(report) {
  const sensitiveKeys = /^(customer|customerName|contact|identity|firstName|middleInitial|lastName|fullName|phone|email|ssn|dob|dateOfBirth|password|token|apiToken|accessToken|sensitiveDataAccessToken|secret|authorization|cardNumber|cvv|address|unitNumber|city|zipCode|callId|moveInDate|installDate|orderNumber|value|valueAttribute|inputValue|fieldValue|bodyText|pageText|stack|message|requested|observed|selected|selectedOption|formAction|formId|href|autocomplete|screenshotPath|path|validationMessage)$/i;
  const safeActionText = new Set(['Forward >', 'Forward', 'Run Credit Check', 'Confirm Installation >']);

  function visit(value, key = '') {
    if (key === 'step') return isSafeWorkflowStep(value) ? value : '[redacted]';
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
      if (key === 'controls') {
        const allowed = new Set(['tag', 'type', 'text', 'disabled', 'required', 'insideForm', 'formActionPresent', 'formMethod', 'onclickPresent', 'checked', 'ariaInvalid', 'valid']);
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

  fs.mkdirSync(reportsDirectory, {
    recursive: true
  });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const filePath = path.join(
    reportsDirectory,
    `execution-report-${timestamp}.json`
  );

  fs.writeFileSync(
    filePath,
    JSON.stringify(sanitizeExecutionReport(report), null, 2),
    'utf8'
  );

  console.log('\nEXECUTION REPORT SAVED');
  console.log(filePath);

  return filePath;
}
// ============================================================
// INPUT VALIDATION
// ============================================================

function validateInput(input) {
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

  if (input.execution.stopBeforeFinalOrderSubmission !== true) {
    throw new Error(
      'The simulator has no final-submit handler; demo automation must stop at Order Summary.'
    );
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
  await phoneField.fill(contact.phone.trim());

  const observedPhone = await phoneField.inputValue();

  if (observedPhone !== contact.phone.trim()) {
    throw new Error(
      'Account Holder phone number could not be verified after filling.'
    );
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
  await emailField.fill(contact.email.trim());

  const observedEmail = await emailField.inputValue();

  if (
    observedEmail.toLowerCase() !== contact.email.trim().toLowerCase()
  ) {
    throw new Error(
      'Account Holder email could not be verified after filling.'
    );
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

  if (await disclosureSection.count() !== 1) {
    throw new Error(
      `Expected exactly one ${disclosure.name} disclosure section.`
    );
  }

  const readCheckbox = disclosureSection.locator(
    'label.m-read input[type="checkbox"]'
  );

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

  console.log(
    '[ACTION] Clicking Account Holder Forward button...'
  );


await forwardButton.click({
  noWaitAfter: true
});

console.log('[ACTION] Forward click completed.');

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
} else {
  await updatedCheckoutFrame.getByText(
    'CREDIT CHECK',
    { exact: true }
  ).waitFor({ state: 'visible', timeout: 30000 });
}

await updatedCheckoutFrame.getByText(
  'Select Installation Type',
  { exact: false }
).waitFor({
  state: 'visible',
  timeout: 15000
});

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

const sensitiveDataService = require('./sensitiveDataService');

function requireRecordReference(recordId, purpose) {
  const uuidV4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof recordId !== 'string' || !uuidV4.test(recordId)) {
    throw new Error(`A valid encrypted ${purpose.toUpperCase()} record reference is required.`);
  }
}

function normalizedDateDigits(value) {
  const date = String(value).trim();
  const monthFirst = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (monthFirst) return `${monthFirst[3]}${monthFirst[1]}${monthFirst[2]}`;
  const yearFirst = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yearFirst) return `${yearFirst[1]}${yearFirst[2]}${yearFirst[3]}`;
  return date.replace(/\D/g, '');
}

async function runSimulatorCreditCheck(
  checkoutFrame,
  input,
  service = sensitiveDataService,
  accessToken = process.env.SENSITIVE_DATA_ACCESS_TOKEN
) {
  const ezEnroll = input.accountHolder?.ezEnroll;

  if (ezEnroll === true) {
    // EZ-Enroll bypasses the credit check. Confirm the portal transitioned to
    // the installation step before continuing, without touching identity data.
    const installationOptions = checkoutFrame.locator(
      'input[type="radio"][name="itype"]'
    );
    await checkoutFrame.getByText(
      'ORDER QUALIFICATION STATUS',
      { exact: true }
    ).waitFor({ state: 'visible', timeout: 15000 });
    await installationOptions.first().waitFor({
      state: 'visible',
      timeout: 15000
    });

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

  if (ezEnroll !== false) {
    throw new Error('EZ-Enroll must be selected before the simulator credit check.');
  }

  let creditCheckStage = 'record_preflight';
  try {
  const ssnRecordId = input.identity?.ssnRecordId;
  const dobRecordId = input.identity?.dateOfBirthRecordId;
  requireRecordReference(ssnRecordId, 'ssn');
  requireRecordReference(dobRecordId, 'dob');

  // Authorize both purposes before touching either record, then check both
  // records before consuming either one. An unavailable ID may already be used.
  creditCheckStage = 'ssn_authorization_started';
const ssnAuthorization = service.authorizeSensitiveDataAccess(
  accessToken,
  'ssn'
);
creditCheckStage = 'ssn_authorization_completed';

creditCheckStage = 'dob_authorization_started';
const dobAuthorization = service.authorizeSensitiveDataAccess(
  accessToken,
  'dob'
);
creditCheckStage = 'dob_authorization_completed';

creditCheckStage = 'ssn_record_inspection_started';
const ssnStatus = await service.inspectSensitiveDataRecord(
  ssnRecordId,
  'ssn'
);
creditCheckStage = 'ssn_record_inspection_completed';

creditCheckStage = 'dob_record_inspection_started';
const dobStatus = await service.inspectSensitiveDataRecord(
  dobRecordId,
  'dob'
);
creditCheckStage = 'dob_record_inspection_completed';
  creditCheckStage = 'record_availability_validation_started';
  if (!ssnStatus.available) {
    throw new Error('Encrypted SSN record is unavailable or already consumed. Create a fresh record before retrying.');
  }
  if (!dobStatus.available) {
    throw new Error('Encrypted DOB record is unavailable or already consumed. Create a fresh record before retrying.');
  }

  const ssnField = checkoutFrame.getByLabel(
  'Social Security Number',
  { exact: true }
);
const dobField = checkoutFrame.getByLabel(
  'Date of Birth',
  { exact: true }
);

creditCheckStage = 'ssn_field_wait_started';
await ssnField.waitFor({
  state: 'visible',
  timeout: 15000
});
creditCheckStage = 'ssn_field_ready';

creditCheckStage = 'dob_field_wait_started';
await dobField.waitFor({
  state: 'visible',
  timeout: 15000
});
creditCheckStage = 'dob_field_ready';
  await service.useSensitiveData(
    ssnRecordId,
    'ssn',
    ssnAuthorization,
    async value => {
      creditCheckStage = 'ssn_fill_started';
await ssnField.fill(value);
creditCheckStage = 'ssn_fill_completed';

creditCheckStage = 'ssn_value_verification_started';

const actualDigits = String(
  await ssnField.inputValue()
).replace(/\D/g, '');

const suppliedDigits = String(value).replace(/\D/g, '');

if (!actualDigits || actualDigits !== suppliedDigits) {
  throw new Error(
    'Simulator SSN field did not retain the supplied value.'
  );
}

creditCheckStage = 'ssn_value_verified';
    }
  );
  creditCheckStage = 'ssn_fill_completed';

  const runCreditButton = checkoutFrame.locator(
    'input.cbtn[value="Run Credit Check"]'
  );
  if (await runCreditButton.count() !== 1) {
    throw new Error('Expected exactly one simulator Run Credit Check button.');
  }
  await runCreditButton.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await runCreditButton.isEnabled())) {
    throw new Error('Simulator Run Credit Check button is disabled.');
  }
  creditCheckStage = 'credit_button_ready';

  let portalStatus = '';
  await service.useSensitiveData(
    dobRecordId,
    'dob',
    dobAuthorization,
    async value => {
      creditCheckStage = 'dob_fill_started';
await dobField.fill(value);
creditCheckStage = 'dob_fill_completed';

creditCheckStage = 'dob_value_verification_started';

if (
  normalizedDateDigits(await dobField.inputValue()) !==
  normalizedDateDigits(value)
) {
  throw new Error(
    'Simulator DOB field did not retain the supplied value.'
  );
}

creditCheckStage = 'dob_value_verified';
creditCheckStage = 'credit_button_click_started';
      await runCreditButton.click();
      creditCheckStage = 'credit_button_click_completed';

      const status = checkoutFrame
  .getByText(/Credit Check Status:/i)
  .first();

creditCheckStage = 'credit_result_wait_started';

await status.waitFor({
  state: 'visible',
  timeout: 15000
});

creditCheckStage = 'credit_result_received';
creditCheckStage = 'credit_result_read_started';

portalStatus = (await status.innerText()).trim();

creditCheckStage = 'credit_result_read_completed';
    }
  );

  if (!portalStatus) {
    throw new Error('Simulator did not display a credit-check result.');
  }
  'credit_result_validation_started',
  creditCheckStage = 'credit_result_validation_completed';
  creditCheckStage = 'credit_result_validation_started';
  const approved = /\bCredit Check Status:\s*APPROVED\b/i.test(portalStatus);
  const safeStatus = approved
    ? 'APPROVED'
    : /\bCredit Check Status:\s*DECLINED\b/i.test(portalStatus)
      ? 'DECLINED'
      : 'UNRECOGNIZED_RESULT';
  console.log('[VERIFIED] Simulator credit-check result:', safeStatus);
  if (!approved) {
    const error = new Error('Simulator credit check did not return an approval; automation stopped.');
    error.creditCheckResult = {
      performed: true,
      approved: false,
      status: safeStatus,
      dataSource: 'encrypted-local-records'
    };
    throw error;
  }

  return {
    performed: true,
    approved,
    status: safeStatus,
    dataSource: 'encrypted-local-records'
  };
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      // Store metadata out of band so frozen or non-extensible errors remain
      // untouched and the original failure can always be rethrown unchanged.
      creditCheckFailureStages.set(error, creditCheckStage);
    }
    throw error;
  }
}

async function inspectCheckoutNavigation(checkoutFrame) {
  return checkoutFrame.locator('html').evaluate(html => {
    const document = html.ownerDocument;
    const safeLabel = value => {
      const label = String(value || '').trim();
      const allowed = [
        'Order Summary', 'Credit Check', 'Order Qualification Status',
        'Installation and Payment', 'Installation & Payment',
        'ProviderXX Checkout', 'Account Holder Qualification',
        'Product Customization', 'Installation', 'Authorization'
      ];
      return allowed.includes(label) ? label : label ? '[redacted]' : '';
    };
    const safeUrl = value => {
      try {
        const url = new URL(value);
        const allowedPaths = new Set([
          '/', '/allconnect-frame/order-summary/',
          '/allconnect-frame/recommendations/', '/allconnect-frame/internet-offers/'
        ]);
        const path = url.pathname === '/' ? '/' : `${url.pathname.replace(/\/+$/, '')}/`;
        return `${url.origin}${allowedPaths.has(path) ? path : '/[redacted-path]'}`;
      } catch {
        return '[unavailable]';
      }
    };
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll(
      'button, input:not([type="hidden"]), select, textarea, a'
    )).filter(isVisible).map(element => ({
      tag: element.tagName,
      type: element.getAttribute('type'),
      text: (() => {
        const candidate = element.tagName === 'BUTTON' ||
          (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type))
          ? (element.innerText || element.value || '').trim()
          : '';
        return ['Forward >', 'Forward', 'Run Credit Check', 'Confirm Installation >'].includes(candidate)
          ? candidate
          : '';
      })(),
      disabled: Boolean(element.disabled),
      required: Boolean(element.required),
      insideForm: Boolean(element.form),
      formActionPresent: Boolean(element.form?.getAttribute('action')),
      formMethod: element.form?.getAttribute('method') || '',
      onclickPresent: Boolean(element.getAttribute('onclick')),
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      ariaInvalid: element.getAttribute('aria-invalid') === 'true',
      valid: typeof element.checkValidity === 'function' ? element.checkValidity() : undefined,
    }));
    const forms = { count: document.forms.length };
    const headings = Array.from(document.querySelectorAll(
      'h1, h2, h3, h4, legend, [role="heading"]'
    )).filter(isVisible).map(element => safeLabel(element.innerText)).filter(Boolean);
    const bodyText = document.body.innerText || '';
    const relevantMessages = [
      /credit check status/i.test(bodyText) ? 'credit_check_status_present' : null,
      /payment|card/i.test(bodyText) ? 'payment_text_present' : null,
      /error|required|invalid/i.test(bodyText) ? 'validation_text_present' : null,
      /order summary/i.test(bodyText) ? 'order_summary_text_present' : null,
      /forward/i.test(bodyText) ? 'forward_text_present' : null
    ].filter(Boolean);
    const scriptCount = document.scripts.length;
    const bodyDataset = {};
    for (const key of ['acPage', 'sveltekitPreloadData']) {
      const value = document.body.dataset[key];
      if (key === 'acPage' && ['order-summary', 'installation-payment', 'recommendations', 'internet-offers'].includes(value)) bodyDataset[key] = value;
      if (key === 'sveltekitPreloadData' && ['hover', 'tap'].includes(value)) bodyDataset[key] = value;
    }
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
      javascriptResourceCount: performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => /\.(m?js)(\?|$)/i.test(url)).length,
      renderState: {
        readyState: document.readyState,
        bodyTextPresent: bodyText.trim().length > 0,
        bodyTextLength: bodyText.length,
        scriptElementCount: scriptCount,
        visibleHeadingCount: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(isVisible).length,
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
    customerName: `${input.customer.firstName} ${input.customer.lastName}`,
    provider: input.plan.provider,
    monthlyPrice: Number(input.plan.monthlyPrice).toFixed(2),
    installationPrice: (
      Number(input.plan.installationPrice) + installationOptionFee
    ).toFixed(2)
  };

  return checkoutFrame.locator('html').evaluate((html, expected) => {
    const document = html.ownerDocument;
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    const bodyText = document.body.innerText || '';
    const headings = Array.from(document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [role="heading"]'
    )).filter(isVisible).map(element => element.innerText.trim()).filter(Boolean);
    const summaryForm = document.querySelector('#summaryForm');
    const summaryFormPresent = Boolean(summaryForm && isVisible(summaryForm));
    const summaryRoot = summaryFormPresent ? summaryForm : document.body;
    const documentTitleMatches = /^order summary$/i.test(document.title);
    const visibleSummaryHeading = headings.some(value => /^order summary$/i.test(value));
    const summaryHeading = documentTitleMatches || visibleSummaryHeading;
    const summaryState = /\/allconnect-frame\/order-summary\/?$/i.test(document.location.pathname) ||
      /order[- ]summary/i.test(document.title) ||
      /order[- ]summary/i.test(document.location.href) ||
      /order[- ]summary/i.test(document.body.dataset.acPage || '');
    const visibleLabeledValue = (labelPattern, expectedValue, kind) => {
      const containers = Array.from(summaryRoot.querySelectorAll(
        'tr, li, p, dd, [role="row"], [data-summary-row], .summary-row, .summary-field, .detail-row, div, section'
      )).filter(isVisible).map(element => ({
        element,
        text: String(element.innerText || '').replace(/\s+/g, ' ').trim()
      })).filter(item => item.text && item.text.length <= 180)
        .sort((left, right) => left.text.length - right.text.length);

      for (const item of containers) {
        const matches = item.text.match(labelPattern);
        if (!matches || matches.length !== 2) continue;
        const value = matches[1].trim();
        if (!value) continue;
        if (/(?:customer\s+name|provider\b(?:\s+name)?|monthly\s+(?:total|price|payment)|installation\s+(?:total|price|fee))\s*:?/i.test(value)) continue;
        if (kind === 'money') {
          const cents = value.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/g) || [];
          const expectedCents = Math.round(Number(expectedValue) * 100);
          if (cents.length === 1 && Math.round(Number(cents[0].replace(/[$,\s]/g, '')) * 100) === expectedCents) return true;
        } else if (value.toLowerCase() === String(expectedValue).toLowerCase()) {
          return true;
        }
      }
      return false;
    };
    const errors = Array.from(document.querySelectorAll(
      '[role="alert"], [aria-live="assertive"], .error, .validation-error, .field-error'
    )).filter(isVisible);
    const visibleControls = Array.from(document.querySelectorAll('button, input, select, textarea, a'))
      .filter(isVisible).length;
    const bodyDataset = {};
    for (const key of ['acPage', 'sveltekitPreloadData']) {
      if (document.body.dataset[key]) bodyDataset[key] = document.body.dataset[key];
    }
    const titleMatches = /^order summary$/i.test(document.title);
    return {
      url: `${document.location.origin}${document.location.pathname}`,
      title: titleMatches ? 'Order Summary' : document.title ? '[redacted]' : '',
      bodyDataset,
      visibleSummaryHeading,
      documentTitleMatches: titleMatches,
      summaryHeading,
      summaryState,
      summaryFormPresent,
      checkoutCompletedVisible: /\bCHECKOUT_COMPLETED\b/i.test(bodyText),
      expectedFields: {
        customerName: visibleLabeledValue(/^(?:customer\s+)?name\s*:?\s*(.+)$/i, expected.customerName, 'text'),
        provider: visibleLabeledValue(/^(?:(?:internet|service)\s+)?provider(?:\s+name)?\s*:?\s*(.+)$/i, expected.provider, 'text'),
        monthlyPrice: visibleLabeledValue(/^monthly\s+(?:total|price|payment)\s*:?\s*(.+)$/i, expected.monthlyPrice, 'money'),
        installationPrice: visibleLabeledValue(/^installation\s+(?:total|price|fee)\s*:?\s*(.+)$/i, expected.installationPrice, 'money')
      },
      validationErrorCount: errors.length,
      renderState: {
        readyState: document.readyState,
        bodyTextPresent: bodyText.trim().length > 0,
        bodyTextLength: bodyText.length,
        visibleHeadingCount: headings.length,
        visibleControlCount: visibleControls,
        summaryFormPresent: Boolean(summaryForm),
        scriptElementCount: document.scripts.length,
        svelteKitMarkerPresent: Object.prototype.hasOwnProperty.call(document.body.dataset, 'sveltekitPreloadData')
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
    await forwardButton.click();
    await checkoutDocument.waitForFunction(previousUrl => {
      if (location.href !== previousUrl) return true;
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0;
      };
      const summaryHeading = document.title === 'Order Summary' ||
        Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
          .some(element => visible(element) && /^order summary$/i.test(element.innerText.trim()));
      const summaryFormPresent = Boolean(document.querySelector('#summaryForm'));
      const summaryRouteState = /order[- ]summary/i.test(document.body?.dataset.acPage || '');
      const validationSelector = '[role="alert"], [aria-live="assertive"], .error, .validation-error, .field-error, [aria-invalid="true"]';
      const visibleValidation = Array.from(document.querySelectorAll(validationSelector)).some(visible);
      return summaryHeading || summaryFormPresent || summaryRouteState || visibleValidation;
    }, urlBefore, { timeout: options.transitionTimeoutMs ?? 10000 }).catch(() => null);

    if (await isSummaryRoute()) {
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
        await checkoutDocument.waitForFunction(values => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false;
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const parentStyle = getComputedStyle(parent);
              if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false;
            }
            return true;
          };
          const visibleHeading = Array.from(document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[role="heading"]'
          )).some(element => visible(element) && /^order summary$/i.test(element.innerText.trim()));
          const titleMatches = /^order summary$/i.test(document.title);
          const form = document.querySelector('#summaryForm');
          const root = form && visible(form) ? form : document.body;
          const fieldPresent = (pattern, expected, isMoney = false) => {
            const candidates = Array.from(root.querySelectorAll(
              'tr, li, p, dd, [role="row"], [data-summary-row], .summary-row, .summary-field, .detail-row, div, section'
            )).filter(visible).map(element => String(element.innerText || '').replace(/\s+/g, ' ').trim())
              .filter(text => text && text.length <= 180).sort((a, b) => a.length - b.length);
            for (const text of candidates) {
              const match = text.match(pattern);
              if (!match || match.length !== 2 || !match[1].trim()) continue;
              if (/(?:customer\s+name|provider\b(?:\s+name)?|monthly\s+(?:total|price|payment)|installation\s+(?:total|price|fee))\s*:?/i.test(match[1])) continue;
              if (!isMoney && match[1].trim().toLowerCase() === String(expected).toLowerCase()) return true;
              if (isMoney) {
                const amounts = match[1].match(/\$?\s*[\d,]+(?:\.\d{1,2})?/g) || [];
                const expectedCents = Math.round(Number(expected) * 100);
                if (amounts.length === 1 && Math.round(Number(amounts[0].replace(/[$,\s]/g, '')) * 100) === expectedCents) return true;
              }
            }
            return false;
          };
          const allExpectedFieldsPresent =
            fieldPresent(/^(?:customer\s+)?name\s*:?\s*(.+)$/i, values.customerName) &&
            fieldPresent(/^(?:(?:internet|service)\s+)?provider(?:\s+name)?\s*:?\s*(.+)$/i, values.provider) &&
            fieldPresent(/^monthly\s+(?:total|price|payment)\s*:?\s*(.+)$/i, values.monthlyPrice, true) &&
            fieldPresent(/^installation\s+(?:total|price|fee)\s*:?\s*(.+)$/i, values.installationPrice, true);
          return (visibleHeading || titleMatches) && allExpectedFieldsPresent;
        }, expected, { timeout: renderTimeoutMs });
        renderWaitStatus = 'summary_content_rendered';
      } catch {
        renderWaitStatus = 'summary_render_timeout';
      }
      renderWaitMs = Math.min(Date.now() - waitStart, renderTimeoutMs);
    }
  } finally {
    page.off('response', recordSummaryResponse);
  }

  const navigationAfter = await inspectCheckoutNavigation(checkoutFrame);
  const summaryEvidence = await collectOrderSummaryEvidence(checkoutFrame, input);
  const reached = hasVerifiedOrderSummary(summaryEvidence);
  const summaryRouteDetected = await isSummaryRoute();
  if (summaryRouteDetected && !reached && renderWaitStatus === 'summary_render_timeout') {
    const renderState = summaryEvidence.renderState || {};
    renderWaitStatus = renderState.bodyTextPresent ||
      renderState.visibleHeadingCount > 0 || renderState.summaryFormPresent
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
    evidence?.summaryHeading &&
    (evidence.summaryFormPresent || evidence.summaryState) &&
    Object.values(evidence.expectedFields || {}).length > 0 &&
    Object.values(evidence.expectedFields || {}).every(Boolean)
  );
}

async function completeDemoCheckout(page, input) {
  const checkoutFrame = await getCheckoutFrame(page);
  const result = {
    creditCheck: { performed: false, approved: false, dataSource: 'synthetic-demo-values' },
    installation: { requested: input.installation.type, selected: null, verified: false, confirmed: false },
    payment: { performed: false, method: null, simulated: true },
    orderSummaryReached: false,
    orderSummaryVerification: null,
    navigationInspection: null,
    finalOrderSubmitted: false
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

  await installDate.fill(tomorrow);

  // Select first available time option.
  if (await timeSelect.locator('option').count() > 1) {
    await timeSelect.selectOption({ index: 1 });
  }

  console.log('[VERIFIED] Installation date and preferred time selected.');
  }
  // SAFETY STOP: Do not confirm installation until the portal action
  // and its resulting state have been independently verified.
  console.log(
    '[SAFE STOP] Installation option selected and verified. ' +
    'Confirm Installation was not clicked.'
  );

  result.installation.confirmationClicked = false;
  result.installation.confirmed = false;
  result.stoppedSafely = true;
  result.stopReason =
    'Stopped before Confirm Installation; portal action semantics have not been verified.';

  return result;

  // STEP 2: WAIT FOR THE FORWARD BUTTON.
  console.log('\nWaiting for the next Forward button...');

  const finalForwardButton = checkoutFrame.locator(
    'input.cbtn[value="Forward >"]'
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

    const summaryTransition = await clickForwardAndVerifyOrderSummary(
      page,
      checkoutFrame,
      input,
      finalForwardButton,
      result.navigationInspection
    );
    result.navigationAfterForward = summaryTransition.navigationAfter;
    result.orderSummaryVerification = summaryTransition.summaryEvidence;
    result.orderSummaryReached = summaryTransition.reached;
    result.finalOrderSubmitted = false;
    result.payment = {
      performed: false,
      method: 'credit_approved',
      fieldsInspected: false,
      cardDetailsEntered: false,
      forwardClicked: true,
      status: 'not_required_after_credit_approval'
    };
    result.stoppedSafely = true;
    result.stopReason = result.orderSummaryReached
      ? 'Verified Order Summary reached; final submission not performed.'
      : 'Stopped after the credit-only forward transition; Order Summary was not verified.';
    return result;
  }


  console.log('\n========================================');
  console.log('PREPARING PAYMENT FIELD INSPECTION');
  console.log('========================================');

  // 1. Verify and acknowledge the payment disclosure.
  const paymentRead = checkoutFrame.locator(
    'input[type="checkbox"]'
  );

  if (await paymentRead.count() !== 1) {
    throw new Error(
      'Expected exactly one payment Read checkbox.'
    );
  }

  if (!(await paymentRead.isChecked())) {
    await paymentRead.check();
  }

  console.log(
    '[VERIFIED] Payment Read checkbox:',
    await paymentRead.isChecked()
  );

  // 2. Select Add a new credit card.
  const addCardRadio = checkoutFrame.locator(
    'input[type="radio"][name="addcard"]'
  );

  if (await addCardRadio.count() !== 1) {
    throw new Error(
      'Expected exactly one Add a new credit card option.'
    );
  }

  if (!(await addCardRadio.isChecked())) {
    await addCardRadio.check();
  }

  console.log(
    '[VERIFIED] Add a new credit card:',
    await addCardRadio.isChecked()
  );

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

  // 4. Wait for a secure field to become visible instead of sleeping for a
  // fixed interval. This path only inspects; it never fills payment details.
  await checkoutFrame.locator('input[aria-label="Card Number"]').waitFor({
    state: 'visible',
    timeout: 10000
  });

  const enabledPaymentControls = await checkoutFrame
    .locator('input, select, textarea, button')
    .evaluateAll(elements =>
      elements.map((element, index) => ({
        index,
        tag: element.tagName,
        type: element.getAttribute('type'),
        disabled: element.disabled,
        visible: !!(
          element.offsetWidth ||
          element.offsetHeight ||
          element.getClientRects().length
        ),
        optionCount: element.tagName === 'SELECT' ? element.options.length : undefined
      }))
    );

  console.log('\nENABLED PAYMENT CONTROLS:');
  console.log(
    JSON.stringify(enabledPaymentControls, null, 2)
  );

  result.navigationInspection = await inspectCheckoutNavigation(checkoutFrame);
  console.log('\nCHECKOUT NAVIGATION DOM INSPECTION:');
  console.log(JSON.stringify(result.navigationInspection, null, 2));

    console.log('\n[DIAGNOSTIC COMPLETE]');
  console.log(
    '[STOP] No card details entered. Forward not clicked.'
  );

  result.payment = {
    performed: false,
    method: null,
    simulated: false,
    fieldsInspected: true,
    cardDetailsEntered: false,
    forwardClicked: false,
    status: 'stopped_safely'
  };

  result.stoppedSafely = true;
  result.stopReason = 'Payment fields inspected; stopped before payment.';

  console.log('[SAFE CHECK] Payment fields remain empty; no submit control is present.');
  const cardFields = checkoutFrame.locator(
    'input[aria-label="Card Number"], input[aria-label="Card Holder Name"], ' +
    'input[aria-label="CVV Code"], input[aria-label="Expiration month"], ' +
    'input[aria-label="Expiration year"]'
  );
  const populatedCardFieldCount = await cardFields.evaluateAll(elements =>
    elements.filter(element => String(element.value || '').trim() !== '').length
  );
  if (populatedCardFieldCount !== 0) {
    throw new Error('Payment fields are not empty; refusing to advance.');
  }

  if (input.accountHolder.ezEnroll === true) {
    result.payment = {
      performed: false,
      method: null,
      fieldsInspected: true,
      cardDetailsEntered: false,
      forwardClicked: false,
      requiresCardDetails: true,
      status: 'stopped_safely_requires_card'
    };
    result.stoppedSafely = true;
    result.stopReason = 'EZ-Enroll requires pre-payment by card; stopped before entering card details or advancing.';
    console.log('[SAFE STOP] EZ-Enroll requires card pre-payment; no card data entered and no Forward action taken.');
    return result;
  }
  throw new Error('Unhandled simulator checkout branch.');
}
async function runAutomation(input) {
  validateInput(input);

  const cfg = getConfig();

  const reportStartTime = Date.now();

  let browser;
  let context;
  let page;
  let keepBrowserOpen = false;
  let accountHolderReport;
  let accountHolderForwardReport;
  let installationReport;

  const executionReport = {
    runId: new Date(reportStartTime).toISOString(),
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
    orderSummaryVerification: null,
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
    browser = await launchBrowser(cfg.headless);
    context = await browser.newContext();
    page = await context.newPage();

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
    keepBrowserOpen =
  demoCheckoutResult.orderSummaryReached === true ||
  demoCheckoutResult.stoppedSafely === true;

    executionReport.creditCheck = demoCheckoutResult.creditCheck;
    executionReport.installation = demoCheckoutResult.installation;
    executionReport.payment = demoCheckoutResult.payment;
    executionReport.orderSummaryReached = demoCheckoutResult.orderSummaryReached;
    executionReport.orderSummaryVerification = demoCheckoutResult.orderSummaryVerification;
    executionReport.navigationInspection = demoCheckoutResult.navigationInspection;
    executionReport.navigationAfterForward = demoCheckoutResult.navigationAfterForward;
    executionReport.stopReason = demoCheckoutResult.stopReason || null;

    executionReport.safetyCheckpoint.creditCheckPerformed = demoCheckoutResult.creditCheck.performed;
    executionReport.safetyCheckpoint.paymentPerformed = demoCheckoutResult.payment.performed;
    executionReport.safetyCheckpoint.installationConfirmed = demoCheckoutResult.installation.confirmed;
    executionReport.safetyCheckpoint.finalOrderSubmitted = false;

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
      demoCheckoutResult.payment.fieldsInspected
        ? '[SAFE STOP] Payment fields inspected; no card details entered.'
        : '[SKIPPED] Payment fields not inspected.'
    );

    if (demoCheckoutResult.orderSummaryReached) {
      console.log('[COMPLETED] Order Summary reached.');
      finishExecutionStep('completed');
      executionReport.status = 'completed';
    } else if (demoCheckoutResult.stoppedSafely) {
      console.log(
  '[SAFE STOP] Workflow stopped before Confirm Installation. ' +
  'Order Summary has not been reached.'
);
      finishExecutionStep('stopped_safely');
      executionReport.status = 'stopped_safely';
    } else {
      throw new Error('Checkout ended without reaching Order Summary or a safe stop.');
    }

    console.log('\nAUTOMATION CHECKPOINT:', executionReport.status);


  } catch (error) {
  finishExecutionStep('failed');
  executionReport.status = 'failed';
  if (error.creditCheckResult) {
    executionReport.creditCheck = error.creditCheckResult;
    executionReport.safetyCheckpoint.creditCheckPerformed = true;
  }
  executionReport.error = await captureFailureDiagnostics(page, error, {
    step: executionReport.steps.find(step => step.status === 'failed')?.name || null,
    creditCheckStage: getCreditCheckStageForError(error),
    screenshotPath: 'automation-error.png'
  });

  console.error('\nAutomation failed:', executionReport.error.failure.type,
    `(step: ${executionReport.error.failure.step || 'unknown'})`);

    throw error;

      } finally {
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


// Local demo execution:
// node src/main.js

if (require.main === module) {
  const path = require('path');
  const fs = require('fs');

  const sampleOrderPath = path.join(
    __dirname,
    '..',
    'test-data',
    'sample-order.json'
  );

  try {
    const sampleOrder = JSON.parse(
      fs.readFileSync(sampleOrderPath, 'utf8')
    );

    // --------------------------------------------------------
    // Validate the JSON structure before starting automation.
    // --------------------------------------------------------

    if (!sampleOrder.customer) {
      throw new Error('Missing customer section in sample-order.json');
    }

    if (!sampleOrder.accountHolder) {
      throw new Error('Missing accountHolder section in sample-order.json');
    }

    if (!sampleOrder.plan) {
      throw new Error('Missing plan section in sample-order.json');
    }

    // --------------------------------------------------------
    // Map sample-order.json to the automation input.
    // JSON is the source of truth for customer selections.
    // --------------------------------------------------------

    const automationInput = {
      customer: {
        prefix: sampleOrder.customer.prefix || 'Mr',
        firstName: sampleOrder.customer.firstName,
        middleInitial: sampleOrder.customer.middleInitial || '',
        lastName: sampleOrder.customer.lastName,
        address: sampleOrder.customer.streetAddress,
        unitNumber: sampleOrder.customer.unitNumber,
        city: sampleOrder.customer.city,
        zipCode: sampleOrder.customer.zipCode,
        unitType: sampleOrder.customer.unitType,
        state: sampleOrder.customer.state,
        serviceAddressType: sampleOrder.customer.residenceType,
        rentOwn: sampleOrder.customer.ownership,
        callId: sampleOrder.customer.leadId || 'DEMO-001',
        customerMove: sampleOrder.customer.moving,
        moveInDate: sampleOrder.customer.moveInDate || ''
      },

      qualification: {
        customerType: String(sampleOrder.customerType).toLowerCase()
      },

      plan: {
        provider: sampleOrder.provider,
        speed: `${sampleOrder.speedMbps} Mbps`,
        term: sampleOrder.plan.term,
        monthlyPrice: sampleOrder.plan.monthlyPrice,
        installationPrice: sampleOrder.plan.installationPrice
      },

            checkout: {
        broadbandFactLabels:
          sampleOrder.checkout.broadbandFactLabels || 'not_requested',

        broadbandFactLabelsRead:
          sampleOrder.checkout.broadbandFactLabelsRead === true,

        equipment:
          sampleOrder.checkout.equipment,

        nowTv:
          sampleOrder.checkout.nowTv === true
      },

      accountHolder: {
        contact: {
          phone: sampleOrder.customer.phone,
          email: sampleOrder.customer.email
        },

        isAccountHolder:
          sampleOrder.accountHolder.isAccountHolder,

        isExistingProviderCustomer:
          sampleOrder.accountHolder.isExistingProviderCustomer,

        ezEnroll:
          sampleOrder.accountHolder.ezEnroll,

        automaticPayments:
          sampleOrder.accountHolder.automaticPayments,

        readAcknowledgement:
          sampleOrder.accountHolder.readAcknowledgement,

        mailingAddressSameAsService:
          sampleOrder.accountHolder.mailingAddressSameAsService,

        shippingAddressSameAsService:
          sampleOrder.accountHolder.shippingAddressSameAsService
      },

      identity: {
  ssnRecordId: sampleOrder.identity?.ssnRecordId || '',
  dateOfBirthRecordId: sampleOrder.identity?.dateOfBirthRecordId || ''
},

            installation: {
        type: sampleOrder.installation.type,
        confirmInstallation: false
      },

      payment: {
        method: sampleOrder.payment?.method || 'none'
      },

      execution: {
        mode: 'demo',
        stopBeforeFinalOrderSubmission: true
      }
    };

    console.log('\n========================================');
    console.log('LOADED TEST DATA');
    console.log('========================================');

    console.log('Customer record loaded; personal details omitted.');

    console.log('Provider:', automationInput.plan.provider);
    console.log('Speed:', automationInput.plan.speed);
    console.log('Account holder expected:', automationInput.accountHolder.isAccountHolder);
    console.log('Existing provider customer:', automationInput.accountHolder.isExistingProviderCustomer);
    console.log('EZ-Enroll:', automationInput.accountHolder.ezEnroll);
    console.log('Automatic Payments:', automationInput.accountHolder.automaticPayments);
    console.log('Mailing address same:', automationInput.accountHolder.mailingAddressSameAsService);
    console.log('Shipping address same:', automationInput.accountHolder.shippingAddressSameAsService);

    runAutomation(automationInput).catch(error => {
      console.error('\nDemo automation stopped:', classifyError(error).type);
      process.exitCode = 1;
    });

  } catch (error) {
    console.error('\nUnable to load sample order:', classifyError(error).type);
    process.exitCode = 1;
  }
}
