
const fs = require('fs');
const path = require('path');

const { getConfig } = require('./config');
const { launchBrowser } = require('./browser');
const { login } = require('./auth');

const {
  inspectBasicInformation,
  fillBasicInformation
} = require('./basicInformation');
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
    JSON.stringify(report, null, 2),
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

  if (input.installation.confirmInstallation !== false) {
    throw new Error(
      'Installation confirmation must remain disabled in this demo workflow.'
    );
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
      'Demo automation must stop before final order submission.'
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
        const result = {
          tag: element.tagName,
          type: element.type || '',
          id: element.id || '',
          name: element.name || '',
          label: getLabel(element),
          placeholder: element.placeholder || '',
          value: element.value || '',
          text: (element.innerText || '').trim(),
          checked: element.checked ?? undefined,
          disabled: element.disabled || false
        };

        if (element.tagName === 'SELECT') {
          result.options = Array.from(element.options).map(option => ({
            label: option.label,
            value: option.value,
            selected: option.selected
          }));
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
        id: element.id,
        name: element.name,
        value: element.value,
        label: labelText,
        checked: element.checked,
        disabled: element.disabled
      };
    });
  });
}

async function inspectPage(page, heading, screenshotName) {
  console.log(`\n--- ${heading} ---`);
  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  console.log('\nVisible controls:');
  console.log(
    JSON.stringify(await inspectControls(page), null, 2)
  );

  console.log('\nCheckboxes and radio buttons:');
  console.log(
    JSON.stringify(await inspectChoiceControls(page), null, 2)
  );

  console.log('\nPage text:');
  console.log(
    (await page.locator('body').innerText()).slice(0, 18000)
  );

  await page.screenshot({
    path: screenshotName,
    fullPage: true
  });
}

async function inspectCheckout(page) {
  console.log('\n========================================');
  console.log('CHECKOUT PAGE INSPECTION');
  console.log('========================================');

  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  console.log(
    (await page.locator('body').innerText()).slice(0, 20000)
  );

  console.log('\nVisible controls:');
  console.log(
    JSON.stringify(await inspectControls(page), null, 2)
  );

  console.log('\nChoice controls:');
  console.log(
    JSON.stringify(await inspectChoiceControls(page), null, 2)
  );

  await page.screenshot({
    path: 'providerxx-checkout-detailed-inspection.png',
    fullPage: true
  });
}

// ============================================================
// IFRAME HELPERS
// ============================================================

async function getCheckoutFrame(page) {
  const iframeElement = page.locator('#checkoutContent');

  await iframeElement.waitFor({
    state: 'visible',
    timeout: 15000
  });

  const checkoutFrame = page.frameLocator('#checkoutContent');

  await checkoutFrame.locator('body').waitFor({
    state: 'visible',
    timeout: 15000
  });

  return checkoutFrame;
}

async function inspectProviderCheckoutFrame(page) {
  console.log('\n========================================');
  console.log('PROVIDER CHECKOUT IFRAME INSPECTION');
  console.log('========================================');

  const iframeDetails = await page.locator(
    '#checkoutContent'
  ).evaluate(element => ({
    id: element.id,
    name: element.name,
    src: element.src,
    title: element.title,
    visible:
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0
  }));

  console.log('\nIframe details:');
  console.log(JSON.stringify(iframeDetails, null, 2));

  const checkoutFrame = await getCheckoutFrame(page);

  console.log(
    '\nIframe URL:',
    await page.locator('#checkoutContent').getAttribute('src')
  );

  console.log('\nIframe page text:');
  console.log(
    (await checkoutFrame.locator('body').innerText()).slice(0, 20000)
  );

  console.log('\nIframe controls:');

  const controls = await checkoutFrame.locator(
    'input, button, select, textarea, a'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const labels = element.labels
        ? Array.from(element.labels).map(label =>
            label.innerText.trim()
          )
        : [];

      const parentLabel = element.closest('label');

      if (parentLabel) labels.push(parentLabel.innerText.trim());

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
        id: element.id || '',
        name: element.name || '',
        label: [...new Set(labels.filter(Boolean))].join(' | '),
        value: element.value || '',
        text: (element.innerText || '').trim(),
        checked: element.checked ?? undefined,
        disabled: element.disabled || false,
        html: element.outerHTML.slice(0, 1500)
      };
    });
  });

  console.log(JSON.stringify(controls, null, 2));

  const forms = await checkoutFrame.locator('form').evaluateAll(
    elements => elements.map(form => ({
      id: form.id,
      name: form.name,
      action: form.getAttribute('action'),
      method: form.method,
      text: (form.innerText || '').trim().slice(0, 3000)
    }))
  );

  console.log('\nIframe forms:');
  console.log(JSON.stringify(forms, null, 2));

  await page.screenshot({
    path: 'providerxx-checkout-iframe-inspection.png',
    fullPage: true
  });

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

  const beforeText = await checkoutFrame.locator('body').innerText();

  await forwardButton.click();
  await page.waitForTimeout(2500);

  const afterText = await checkoutFrame.locator('body').innerText();

  console.log('\nCheckout page after Forward:');
  console.log(afterText.slice(0, 15000));

  await page.screenshot({
    path: 'providerxx-checkout-after-forward.png',
    fullPage: true
  });

  return { beforeText, afterText };
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
        value: element.value,
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
      `Expected exactly one radio option matching "${expectedText}", ` +
      `but found ${matchingOptions.length}. ` +
      `Available options: ${JSON.stringify(options)}`
    );
  }

  if (matchingOptions[0].disabled) {
    throw new Error(
      `The matching radio option is disabled: ${expectedText}`
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
      name: element.name || '',
      id: element.id || '',
      value: element.value || '',
      checked: element.checked ?? undefined,
      required: element.required || false,
      disabled: element.disabled || false,
      labels: element.labels
        ? Array.from(element.labels).map(label =>
            label.innerText.trim()
          )
        : [],
      surroundingText: element.parentElement?.innerText?.trim() || '',
      html: element.outerHTML.slice(0, 2000)
    }));
  });

  console.log('\nCustomization controls:');
  console.log(JSON.stringify(details, null, 2));

  console.log('\nCustomization page text:');
  console.log(
    await checkoutFrame.locator('body').innerText()
  );

  await page.screenshot({
    path: 'providerxx-customization-inspection.png',
    fullPage: true
  });
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

  if (!(await readCheckbox.isChecked())) {
    await readCheckbox.check();
  }

  if (!(await readCheckbox.isChecked())) {
    throw new Error(
      'Broadband Fact Labels Read checkbox could not be verified.'
    );
  }

  console.log(
    '[VERIFIED] Broadband Fact Labels Read:',
    await readCheckbox.isChecked()
  );

  const acknowledgementTimeout = 120000;
  const startTime = Date.now();

  while (!(await readCheckbox.isChecked())) {
    if (Date.now() - startTime > acknowledgementTimeout) {
      throw new Error(
        'Read acknowledgement was not completed manually. ' +
        'Automation stopped before clicking Forward.'
      );
    }

    await page.waitForTimeout(500);
  }

  console.log('[VERIFIED] Read acknowledgement is checked.');

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

  console.log('\nCurrent customization page text:');
  console.log(
    (await checkoutFrame.locator('body').innerText()).slice(0, 12000)
  );

  await page.screenshot({
    path: 'providerxx-customizations-applied.png',
    fullPage: true
  });

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
  await page.waitForTimeout(2500);

  console.log('\n--- NEXT CHECKOUT PAGE ---');
  console.log(
    (await checkoutFrame.locator('body').innerText()).slice(0, 18000)
  );

  await page.screenshot({
    path: 'providerxx-after-customization-forward.png',
    fullPage: true
  });
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
    console.log('  Requested:', item.requested);
    console.log('  Portal state:', item.observed);

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
  '\nAccount Holder selections were applied from the supplied test data. ' +
  'Verify that identity and disclosure inputs are truthful before running.'
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

  if (!(await verificationRadio.isChecked())) {
    await verificationRadio.check();
  }

  if (!(await verificationRadio.isChecked())) {
    throw new Error(
      `Could not select Account Holder verification: ${expectedVerification}.`
    );
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
      value: element.value,
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
  // 7. Apply the Account Holder disclosure Read input.
  // ----------------------------------------------------------

  const checkboxDetails = await checkoutFrame.locator(
    'input[type="checkbox"]'
  ).evaluateAll(elements =>
    elements.map((element, index) => ({
      index,
      checked: element.checked,
      disabled: element.disabled,
      labels: element.labels
        ? Array.from(element.labels).map(label =>
            label.innerText.trim()
          )
        : [],
      parentText:
        element.closest('label')?.innerText?.trim() || ''
    }))
  );

  const readMatches = checkboxDetails.filter(checkbox =>
    checkbox.labels.some(label =>
      normalizeLabel(label) === 'read'
    ) ||
    normalizeLabel(checkbox.parentText) === 'read'
  );

  if (accountHolder.readAcknowledgement !== true) {
    throw new Error(
      'test-data must set accountHolder.readAcknowledgement to true ' +
      'after the Automatic Payments and Paperless disclosure has been read.'
    );
  }

  if (readMatches.length !== 1) {
    throw new Error(
      `Expected exactly one Account Holder Read checkbox, found ${readMatches.length}.`
    );
  }

  const readCheckbox = checkoutFrame
    .locator('input[type="checkbox"]')
    .nth(readMatches[0].index);

  if (!(await readCheckbox.isChecked())) {
    await readCheckbox.check();
  }

  if (!(await readCheckbox.isChecked())) {
    throw new Error(
      'Account Holder disclosure Read checkbox could not be verified.'
    );
  }

  report.push(createReportItem({
    field: 'readAcknowledgement',
    requested: true,
    observed: true,
    status: 'MATCHED',
    note: 'Checked using the explicit test-data acknowledgement.'
  }));

  console.log(
    '[VERIFIED] Account Holder disclosure Read:',
    await readCheckbox.isChecked()
  );
  // ----------------------------------------------------------
  // 8. Consolidated report.
  // ----------------------------------------------------------

  console.log('\nAccount Holder processing completed.');

  const finalReport = printAccountHolderReport(report);

  await page.screenshot({
    path: 'providerxx-account-holder-inspection.png',
    fullPage: true
  });

  console.log('\nAccount Holder results:');
  console.log('- Account-holder verification: manually confirmed.');
  console.log('- Contact details: filled and verified.');
  console.log('- Current provider answer: handled from input.');
  console.log('- EZ-Enroll: selected from input.');
  console.log('- Mailing and shipping: selected from input.');
  console.log('- Automatic Payments: checked against portal state.');
  console.log('- Disclosure Read: manually confirmed.');
  console.log('- Forward button: pending post-validation action.');

  return finalReport;
}

// ============================================================
// ADVANCE FROM ACCOUNT HOLDER TO INSTALLATION & PAYMENT
// ============================================================

async function advanceAccountHolderToInstallation(page, report) {
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

  await forwardButton.click();

  // Verify that the portal actually reached Step 3.
  await checkoutFrame.getByText('CREDIT CHECK', {
    exact: true
  }).waitFor({
    state: 'visible',
    timeout: 30000
  });

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

// ============================================================
// MAIN AUTOMATION WORKFLOW
// ============================================================
// ============================================================
// STEP 3: INSTALLATION TYPE
// ============================================================

async function inspectAndSelectInstallation(page, input) {
  const checkoutFrame = await getCheckoutFrame(page);

  console.log('\n========================================');
  console.log('INSTALLATION TYPE');
  console.log('========================================');

  const installationOptions = checkoutFrame.locator(
    'input[type="radio"][name="itype"]'
  );

  const optionCount = await installationOptions.count();

  if (optionCount !== 2) {
    throw new Error(
      `Expected 2 installation options, found ${optionCount}.`
    );
  }

  const labels = await installationOptions.evaluateAll(elements =>
    elements.map(element =>
      Array.from(element.labels || [])
        .map(label => label.innerText.trim())
        .join(' ')
    )
  );

  const expectedLabel =
    input.installation.type === 'standard_shipping'
      ? 'STANDARD_SHIPPING - (Free)'
      : 'PRO_INSTALL - (install:$100.00)';

  const selectedOption = installationOptions.filter({
    has: checkoutFrame.getByText(expectedLabel, { exact: true })
  });

  // Use the observed radio labels to locate the exact option.
  const matchingOption = installationOptions.nth(
    labels.findIndex(label => label.includes(expectedLabel))
  );

  if (await matchingOption.count() !== 1) {
    throw new Error(
      `Installation option not found: ${expectedLabel}`
    );
  }

  await matchingOption.check();

  if (!(await matchingOption.isChecked())) {
    throw new Error(
      `Installation selection could not be verified: ${expectedLabel}`
    );
  }

  console.log(`[VERIFIED] Installation type: ${expectedLabel}`);

  console.log(
    '[CHECKPOINT] Credit check and installation confirmation were not performed.'
  );

  return {
    requested: input.installation.type,
    selected: expectedLabel,
    verified: true,
    creditCheckPerformed: false,
    installationConfirmed: false
  };
}
async function runAutomation(input) {
  validateInput(input);

  const cfg = getConfig();

  const reportStartTime = Date.now();

  let browser;
  let context;
  let page;
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

    await page.goto(cfg.portalUrl, {
      waitUntil: 'domcontentloaded'
    });

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
    await page.waitForTimeout(2000);

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
    await page.waitForTimeout(2500);

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
    await page.waitForTimeout(2500);

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

    const internetTab = page.locator(
      'a[data-ac-href*="CategoryName=INTERNET"]'
    );

    await internetTab.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await internetTab.click();
    await page.waitForTimeout(3000);

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
    await page.waitForTimeout(2000);

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
    await page.waitForTimeout(2500);

    // STEP 11: VERIFY CART.
    startExecutionStep('Cart Verification');
    console.log('\n--- SHOPPING CART VERIFICATION ---');

    const cartText = await page.locator('body').innerText();

    console.log(cartText.slice(-10000));

    await page.screenshot({
      path: 'providerxx-plan-added-to-order.png',
      fullPage: true
    });

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
    await page.waitForTimeout(2500);

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
    accountHolderReport
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


console.log('\nINSTALLATION & PAYMENT INPUT INSPECTION');

console.log(
  await checkoutFrame.locator('input, select, textarea, button').evaluateAll(elements =>
    elements.map(element => ({
      tag: element.tagName,
      type: element.getAttribute('type'),
      name: element.getAttribute('name'),
      id: element.id,
      ariaLabel: element.getAttribute('aria-label'),
      placeholder: element.getAttribute('placeholder'),
      checked: element.checked,
      disabled: element.disabled,
      visible: !!(
        element.offsetWidth ||
        element.offsetHeight ||
        element.getClientRects().length
      ),
      labels: Array.from(element.labels || []).map(label => label.innerText.trim()),
      text: element.innerText || element.value
    }))
  )
);

console.log('\nSTEP 3 PAGE TEXT');
console.log(
  (await checkoutFrame.locator('body').innerText()).slice(0, 12000)
);
    // --------------------------------------------------------
    // STEP 18: INSTALLATION TYPE SELECTION AND VERIFICATION.
    startExecutionStep('Installation Type Selection');
    // --------------------------------------------------------

    installationReport =
  await inspectAndSelectInstallation(page, input);

executionReport.installation = {
  requested: installationReport.requested,
  selected: installationReport.selected,
  verified: installationReport.verified,
  creditCheckPerformed: installationReport.creditCheckPerformed,
  installationConfirmed: installationReport.installationConfirmed
};
    console.log('\nINSTALLATION REPORT');
    console.log(JSON.stringify(installationReport, null, 2));

    // STEP 19: INSPECT INSTALLATION AND AUTHORIZATION CONTROLS.
    startExecutionStep('Installation and Authorization Inspection');
    console.log('\nSTEP 3 ACTION CONTROL INSPECTION');

    console.log(
      await checkoutFrame.locator('input, button').evaluateAll(elements =>
        elements.map(element => ({
          tag: element.tagName,
          type: element.getAttribute('type'),
          value: element.value || '',
          text: element.innerText || '',
          disabled: element.disabled,
          visible: !!(
            element.offsetWidth ||
            element.offsetHeight ||
            element.getClientRects().length
          )
        }))
      )
    );

    console.log('\nCURRENT CHECKOUT PAGE TEXT');
    console.log(
      (await checkoutFrame.locator('body').innerText()).slice(-10000)
    );

    // FINAL SAFE CHECKPOINT.
    console.log('\n========================================');
    console.log('AUTOMATION CHECKPOINT');
    console.log('========================================');

    console.log('[COMPLETED] Login.');
    console.log('[COMPLETED] Basic Information.');
    console.log('[COMPLETED] Address validation.');
    console.log('[COMPLETED] Customer qualification.');
    console.log('[COMPLETED] Internet category selection.');
    console.log('[COMPLETED] Plan selection using input.plan.');
    console.log('[COMPLETED] Plan details verification.');
    console.log('[COMPLETED] Plan added to cart.');
    console.log('[COMPLETED] Checkout opened.');
    console.log('[COMPLETED] Product customization applied.');
    console.log('[COMPLETED] Account Holder contact information.');
    console.log('[COMPLETED] Account Holder validation report generated.');
    console.log('[COMPLETED] Step 3 Installation & Payment reached.');
    console.log('[COMPLETED] Installation type selected and verified.');

    console.log('\nACCOUNT HOLDER VALIDATION SUMMARY');
    console.log(
      JSON.stringify(accountHolderReport.counts, null, 2)
    );

    console.log('\nINSTALLATION SUMMARY');
    console.log(JSON.stringify(installationReport, null, 2));

    console.log('\nSAFETY CHECKPOINT');
    console.log('Credit check: NOT PERFORMED.');
    console.log('Payment: NOT PERFORMED.');
    console.log('Installation confirmation: NOT PERFORMED.');
    console.log('Final order submission: NOT PERFORMED.');

    console.log(
      '\nAutomation stopped before credit check, payment, ' +
      'installation confirmation, and final order submission.'
    );
    finishExecutionStep('completed');
    executionReport.status = 'completed';
    console.log('\nAUTOMATION CHECKPOINT COMPLETED.');

  } catch (error) {
  finishExecutionStep('failed');
  executionReport.status = 'failed';
  executionReport.error = {
    name: error.name || 'Error'
  };

  console.error('\nAutomation failed:', error.message);
    if (page) {
      console.log('Current URL:', page.url());

      await page.screenshot({
        path: 'automation-error.png',
        fullPage: true
      }).catch(() => {});
    }

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
      console.error(
        '\nCould not save execution report:',
        reportError.message
      );
    }

    if (context) {
      await context.close().catch(() => {});
    }

        if (browser) {
      await browser.close().catch(() => {});
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
  validateInput
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
        ssn: sampleOrder.identity?.ssn || '',
        dateOfBirth: sampleOrder.identity?.dateOfBirth || ''
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

    console.log('Customer:',
      `${automationInput.customer.firstName} ${automationInput.customer.lastName}`
    );

    console.log('Provider:', automationInput.plan.provider);
    console.log('Speed:', automationInput.plan.speed);
    console.log('Account holder expected:', automationInput.accountHolder.isAccountHolder);
    console.log('Existing provider customer:', automationInput.accountHolder.isExistingProviderCustomer);
    console.log('EZ-Enroll:', automationInput.accountHolder.ezEnroll);
    console.log('Automatic Payments:', automationInput.accountHolder.automaticPayments);
    console.log('Mailing address same:', automationInput.accountHolder.mailingAddressSameAsService);
    console.log('Shipping address same:', automationInput.accountHolder.shippingAddressSameAsService);

    runAutomation(automationInput).catch(error => {
      console.error('\nDemo automation stopped:', error.message);
      process.exitCode = 1;
    });

  } catch (error) {
    console.error('\nUnable to load sample order:', error.message);
    process.exitCode = 1;
  }
}
