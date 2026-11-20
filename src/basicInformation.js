
const { captureRedactedScreenshot } = require('./diagnostics');

const FIELD_DELAY_MS = 2000;

function createFieldError(field, reason, cause) {
  const error = new Error(reason);
  error.code = 'FORM_FIELD_ACTION_FAILED';
  error.failureDetails = {
    type: 'field_validation',
    step: 'Basic Information',
    field,
    message: reason
  };
  if (cause) error.name = 'FieldActionError';
  return error;
}

async function fillField(locator, value, field) {
  try {
    await locator.fill(value);
    await new Promise(resolve => setTimeout(resolve, FIELD_DELAY_MS));
  } catch (cause) {
    throw createFieldError(field, `Could not enter ${field}. Check that the field is available and accepts the supplied input.`, cause);
  }
}

async function selectField(locator, value, field) {
  try {
    await locator.selectOption(value);
    await new Promise(resolve => setTimeout(resolve, FIELD_DELAY_MS));
  } catch (cause) {
    throw createFieldError(field, `Could not select ${field}. Check that the requested option is available.`, cause);
  }
}

async function inspectBasicInformation(page) {
  if (process.env.AUTOMATION_DIAGNOSTICS !== 'true') return;
  console.log('\n--- BASIC INFORMATION PAGE ---');
  console.log('\n--- VISIBLE INPUT FIELD DETAILS ---');

  const inputDetails = await page.locator('input, textarea').evaluateAll(elements =>
    elements.map(element => ({
      tag: element.tagName,
      type: element.type || '',
      visible: !!(element.offsetWidth || element.offsetHeight)
    }))
  );

  console.log(inputDetails);

  const fields = [
    '#namePrefixList',
    '#unitTypeList',
    '#stateList',
    '#serviceAddressTypeList',
    '#rentOwnList',
    '#customerMove',
    '#ssZipCode',
    'input[name="rvCallID"]'
  ];

  for (const selector of fields) {
    const field = page.locator(selector);
    const count = await field.count();

    console.log(`\nField: ${selector}`);
    console.log('Found:', count > 0);

    if (count === 0) continue;

    console.log('Visible:', await field.first().isVisible());

    const tagName = await field.first().evaluate(
      element => element.tagName
    );

    console.log('Element type:', tagName);

    if (tagName === 'SELECT') {
      const options = await field.first().locator('option').evaluateAll(
        elements => elements.map(option => ({
          label: option.label
        }))
      );

      console.log('Options:', options);
    }
  }

  await captureRedactedScreenshot(page, 'basic-information-debug.png');

  console.log('Inspection completed.');
}


// Find and fill the moving date when the portal displays that field.
async function fillMovingDate(page, moveInDate) {
  console.log('\n--- MOVING DATE HANDLING ---');

  if (!moveInDate) {
    throw createFieldError('Moving Date', 'Could not enter Moving Date. Check that the field is available and accepts the supplied input.');
  }

  const dateFieldCandidates = [
    'input[type="date"]',
    '#moveInDate',
    '#movingDate',
    '#customerMoveDate',
    'input[name*="moveInDate" i]',
    'input[name*="movingDate" i]',
    'input[id*="moveInDate" i]',
    'input[id*="movingDate" i]',
    'input[placeholder*="move" i]',
    'input[aria-label*="move" i]'
  ];

  let dateField = null;

  for (const selector of dateFieldCandidates) {
    const candidate = page.locator(selector).filter({
      visible: true
    }).first();

    try {
      if (await candidate.count() > 0 && await candidate.isVisible()) {
        dateField = candidate;
        console.log('Moving date field found:', selector);
        break;
      }
    } catch (error) {
      // Continue checking the remaining selectors.
    }
  }

  if (!dateField) {
    throw createFieldError('Moving Date', 'Could not enter Moving Date. Check that the field is available and accepts the supplied input.');
  }

  await dateField.waitFor({
    state: 'visible',
    timeout: 10000
  });

  const fieldType = await dateField.getAttribute('type');
  const suppliedDate = String(moveInDate).trim();
  let dateForField = suppliedDate;

  // HTML date controls only accept ISO dates, while scenario files commonly
  // use the portal's display format (MM/DD/YYYY).
  if (fieldType === 'date' && /^\d{2}\/\d{2}\/\d{4}$/.test(suppliedDate)) {
    const [month, day, year] = suppliedDate.split('/');
    dateForField = `${year}-${month}-${day}`;
  }

  await fillField(dateField, dateForField, 'Moving Date');

  const actualDate = await dateField.inputValue();

  if (actualDate !== dateForField) {
    throw createFieldError('Moving Date', 'The entered Moving Date could not be verified.');
  }

  await dateField.evaluate(field => field.blur());

  console.log('Moving date entered and verified.');
}


async function fillBasicInformation(page, customer) {
  console.log('\n--- FILLING BASIC INFORMATION ---');

  // 1. Select customer prefix
  await selectField(page.locator('#namePrefixList'), customer.prefix, 'Name Prefix');

  // 2. Fill customer name
  await fillField(page.locator('#firstName'), customer.firstName, 'First Name');
  await fillField(page.locator('#lastName'), customer.lastName, 'Last Name');

  console.log('Customer name filled.');

  // 3. Enter ZIP code to activate address fields
  const zipField = page.locator('#ssZipCode');
  await fillField(zipField, customer.zipCode, 'ZIP Code');

  const zipIssue = await zipField.evaluate(element => {
    const validity = element.validity;
    if (validity && !validity.valid) {
      if (validity.valueMissing) return 'required';
      if (validity.patternMismatch || validity.typeMismatch || validity.badInput) return 'format';
      return 'invalid';
    }
    if (element.getAttribute('aria-invalid') === 'true') return 'invalid';
    let node = element;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const messages = Array.from(node.querySelectorAll('[role="alert"], .error, .invalid-feedback, .field-error, .validation-error, .help-block, .alert-danger, .text-danger, [class*="error"], [class*="invalid"]'))
        .filter(message => message.getClientRects().length)
        .map(message => (message.textContent || '').toLowerCase());
      if (messages.some(message => /zip|postal/.test(message) && /invalid|incorrect|unsupported|not found|not serviceable|required|enter|valid/.test(message))) return 'portal_rejected';
    }
    return null;
  }).catch(() => null);
  if (zipIssue) {
    const reason = zipIssue === 'format'
      ? 'The ZIP Code format is invalid.'
      : zipIssue === 'required'
        ? 'The ZIP Code is required.'
        : 'The portal marked the ZIP Code as invalid or unsupported.';
    throw createFieldError('ZIP Code', reason);
  }

  console.log('ZIP Code entered. Waiting for address fields...');

  // 4. Wait until the portal enables the address field
  const addressField = page.locator('#address1');

  try {
    await addressField.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await page.waitForFunction(() => {
      const field = document.querySelector('#address1');
      return field && !field.disabled;
    }, { timeout: 20000 });
  } catch (cause) {
    throw createFieldError(
      'ZIP Code',
      'The portal did not enable the address fields after ZIP Code entry. Verify that the ZIP Code is accepted by the portal.',
      cause
    );
  }

  console.log('Address field is enabled.');

  // 5. Fill address details
  await fillField(addressField, customer.address, 'Service Address');
  await fillField(page.locator('#unitNumber'), customer.unitNumber, 'Unit Number');
  await fillField(page.locator('#city'), customer.city, 'City');

  console.log('Address details filled.');

  // 6. Select state and dwelling details
  await selectField(page.locator('#stateList'), customer.state, 'State');

  await selectField(page.locator('#serviceAddressTypeList'), customer.serviceAddressType, 'Service Address Type');

  const unitTypeField = page.locator('#unitTypeList');

  await unitTypeField.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await page.waitForFunction(() => {
    const field = document.querySelector('#unitTypeList');
    return field && !field.disabled;
  }, { timeout: 20000 });

  await selectField(unitTypeField, customer.unitType, 'Unit Type');

  await selectField(page.locator('#rentOwnList'), customer.rentOwn, 'Rent or Own');

  // 7. Select customer moving option
  const customerMoveField = page.locator('#customerMove');

  await customerMoveField.waitFor({
    state: 'visible',
    timeout: 10000
  });

  await selectField(customerMoveField, customer.customerMove, 'Customer Moving Option');

  console.log('Customer moving option selected:', customer.customerMove);

  // 8. Enter moving date when the scenario requires it
  const movingValue = String(customer.customerMove)
    .trim()
    .toLowerCase();

  const isMoving =
    movingValue === 'yes' ||
    movingValue === 'true' ||
    movingValue === '1';

  if (isMoving) {
    await fillMovingDate(page, customer.moveInDate);
  } else {
    console.log('Moving date not required for this customer.');
  }

  // 9. Fill call ID
  const callIdField = page.locator('#rvCallID');

  await fillField(callIdField, customer.callId, 'Call ID');

  console.log('Call ID entered.');

  await callIdField.evaluate(field => field.blur());

  console.log('Call ID field blur completed.');

  // 10. Verify entered text fields
  const textFields = {
    '#firstName': customer.firstName,
    '#lastName': customer.lastName,
    '#ssZipCode': customer.zipCode,
    '#address1': customer.address,
    '#unitNumber': customer.unitNumber,
    '#city': customer.city,
    '#rvCallID': customer.callId
  };

  for (const [selector, expected] of Object.entries(textFields)) {
    const actual = await page.locator(selector).inputValue();

    if (actual !== expected) {
      const fieldNames = {
        '#firstName': 'First Name',
        '#lastName': 'Last Name',
        '#ssZipCode': 'ZIP Code',
        '#address1': 'Service Address',
        '#unitNumber': 'Unit Number',
        '#city': 'City',
        '#rvCallID': 'Call ID'
      };
      const fieldName = fieldNames[selector] || 'Customer Field';
      throw createFieldError(fieldName, `The entered ${fieldName} could not be verified.`);
    }
  }

  console.log('All Basic Information text fields verified.');

  // 11. Verify dropdown selections
  const dropdownFields = {
    '#namePrefixList': customer.prefix,
    '#unitTypeList': customer.unitType,
    '#stateList': customer.state,
    '#serviceAddressTypeList': customer.serviceAddressType,
    '#rentOwnList': customer.rentOwn,
    '#customerMove': customer.customerMove
  };

  for (const [selector, expected] of Object.entries(dropdownFields)) {
    const actual = await page.locator(selector).inputValue();

    if (actual !== expected) {
      const fieldNames = {
        '#namePrefixList': 'Name Prefix',
        '#unitTypeList': 'Unit Type',
        '#stateList': 'State',
        '#serviceAddressTypeList': 'Service Address Type',
        '#rentOwnList': 'Rent or Own',
        '#customerMove': 'Customer Moving Option'
      };
      const fieldName = fieldNames[selector] || 'Customer Field';
      throw createFieldError(fieldName, `Could not select ${fieldName}. Check that the requested option is available.`);
    }
  }

  console.log('All dropdown selections verified.');

  if (process.env.AUTOMATION_DIAGNOSTICS === 'true') {
    console.log('Filled-form screenshot omitted to prevent sensitive capture.');
  }
}


module.exports = {
  inspectBasicInformation,
  fillBasicInformation
};
