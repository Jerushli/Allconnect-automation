
const { captureRedactedScreenshot } = require('./diagnostics');

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
    throw new Error(
      'Moving date is required when the customer moving option is Yes.'
    );
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
    throw new Error(
      'Moving date field was not found. Inspect the Basic Information page to identify its actual selector.'
    );
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

  await dateField.fill(dateForField);

  const actualDate = await dateField.inputValue();

  if (actualDate !== dateForField) {
    throw new Error(
      'Moving date verification failed.'
    );
  }

  await dateField.evaluate(field => field.blur());

  console.log('Moving date entered and verified.');
}


async function fillBasicInformation(page, customer) {
  console.log('\n--- FILLING BASIC INFORMATION ---');

  // 1. Select customer prefix
  await page.locator('#namePrefixList').selectOption(customer.prefix);

  // 2. Fill customer name
  await page.locator('#firstName').fill(customer.firstName);
  await page.locator('#lastName').fill(customer.lastName);

  console.log('Customer name filled.');

  // 3. Enter ZIP code to activate address fields
  await page.locator('#ssZipCode').fill(customer.zipCode);

  console.log('ZIP Code entered. Waiting for address fields...');

  // 4. Wait until the portal enables the address field
  const addressField = page.locator('#address1');

  await addressField.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await page.waitForFunction(() => {
    const field = document.querySelector('#address1');
    return field && !field.disabled;
  }, { timeout: 20000 });

  console.log('Address field is enabled.');

  // 5. Fill address details
  await addressField.fill(customer.address);
  await page.locator('#unitNumber').fill(customer.unitNumber);
  await page.locator('#city').fill(customer.city);

  console.log('Address details filled.');

  // 6. Select state and dwelling details
  await page.locator('#stateList').selectOption(customer.state);

  await page.locator('#serviceAddressTypeList')
    .selectOption(customer.serviceAddressType);

  const unitTypeField = page.locator('#unitTypeList');

  await unitTypeField.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await page.waitForFunction(() => {
    const field = document.querySelector('#unitTypeList');
    return field && !field.disabled;
  }, { timeout: 20000 });

  await unitTypeField.selectOption(customer.unitType);

  await page.locator('#rentOwnList').selectOption(customer.rentOwn);

  // 7. Select customer moving option
  const customerMoveField = page.locator('#customerMove');

  await customerMoveField.waitFor({
    state: 'visible',
    timeout: 10000
  });

  await customerMoveField.selectOption(customer.customerMove);

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

  await callIdField.fill(customer.callId);

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
      throw new Error(
        `Verification failed for customer field ${selector}.`
      );
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
      throw new Error(
        `Dropdown verification failed for ${selector}.`
      );
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
