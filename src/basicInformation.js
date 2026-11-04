
async function inspectBasicInformation(page) {
  console.log('\n--- BASIC INFORMATION PAGE ---');
  console.log('\n--- VISIBLE INPUT FIELD DETAILS ---');

const inputDetails = await page.locator('input, textarea').evaluateAll(elements =>
  elements.map(element => ({
    tag: element.tagName,
    type: element.type || '',
    id: element.id,
    name: element.name,
    placeholder: element.placeholder,
    ariaLabel: element.getAttribute('aria-label'),
    value: element.value,
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
          label: option.label,
          value: option.value
        }))
      );

      console.log('Options:', options);
    }
  }

  await page.screenshot({
    path: 'basic-information-debug.png',
    fullPage: true
  });

  console.log('Inspection completed.');
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
  await page.locator('#customerMove').selectOption(customer.customerMove);

  // 7. Fill call ID
  const callIdField = page.locator('#rvCallID');

    await callIdField.fill(customer.callId);

    console.log('Call ID entered:', await callIdField.inputValue());

    await callIdField.evaluate(field => field.blur());

    console.log('Call ID after blur:', await callIdField.inputValue());

    console.log('Call ID field details:',await callIdField.evaluate(field => ({maxLength: field.maxLength,currentValue: field.value,characterCount: field.value.length
  }))
);
  // 8. Verify entered text fields
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
      throw new Error(`Verification failed for ${selector}`);
    }
  }

  console.log('All Basic Information text fields verified.');

  await page.screenshot({
    path: 'basic-information-filled.png',
    fullPage: true
  });
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

  console.log(`${selector}: ${actual}`);

  if (actual !== expected) {
    throw new Error(`Dropdown verification failed for ${selector}`);
  }
}

console.log('All dropdown selections verified.');
  console.log('Filled form screenshot saved.');
}


module.exports = {
  inspectBasicInformation,
  fillBasicInformation
};
