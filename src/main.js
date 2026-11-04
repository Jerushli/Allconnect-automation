
const { getConfig } = require('./config');
const { launchBrowser } = require('./browser');
const { login } = require('./auth');

const {
  inspectBasicInformation,
  fillBasicInformation
} = require('./basicInformation');

const { dummyCustomer } = require('./testData');

// Return visible controls with their labels and current states.
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

        if (label) {
          labels.push(label.innerText.trim());
        }
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

// Inspect checkbox and radio controls with surrounding question text.
async function inspectChoiceControls(page) {
  return page.locator(
    'input[type="checkbox"], input[type="radio"]'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      const visible = (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );

      let parent = element.parentElement;
      let surroundingText = '';

      for (let i = 0; i < 5 && parent; i++) {
        surroundingText = (parent.innerText || '').trim();

        if (surroundingText.length > 0) {
          break;
        }

        parent = parent.parentElement;
      }

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

        if (label) {
          labelText = label.innerText.trim();
        }
      }

      if (!labelText) {
        const parentLabel = element.closest('label');

        if (parentLabel) {
          labelText = parentLabel.innerText.trim();
        }
      }

      return {
        visible,
        type: element.type,
        id: element.id,
        name: element.name,
        value: element.value,
        label: labelText,
        checked: element.checked,
        disabled: element.disabled,
        surroundingText: surroundingText.slice(0, 1500),
        html: element.outerHTML.slice(0, 1000)
      };
    });
  });
}

// Print a reusable page inspection.
async function inspectPage(page, heading, screenshotName) {
  console.log(`\n--- ${heading} ---`);
  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  const controls = await inspectControls(page);

  console.log('\nVisible controls:');
  console.log(JSON.stringify(controls, null, 2));

  const choices = await inspectChoiceControls(page);

  console.log('\nCheckboxes and radio buttons:');
  console.log(JSON.stringify(choices, null, 2));

  console.log('\nPage text:');
  console.log(
    (await page.locator('body').innerText()).slice(0, 18000)
  );

  await page.screenshot({
    path: screenshotName,
    fullPage: true
  });
}

// Inspect the outer checkout page.
async function inspectCheckout(page) {
  console.log('\n========================================');
  console.log('DETAILED CHECKOUT PAGE INSPECTION');
  console.log('========================================');

  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  const bodyText = await page.locator('body').innerText();

  console.log('\n--- CHECKOUT PAGE TEXT ---');
  console.log(bodyText.slice(0, 20000));

  const controls = await inspectControls(page);

  console.log('\n--- ALL VISIBLE CHECKOUT CONTROLS ---');
  console.log(JSON.stringify(controls, null, 2));

  const choices = await inspectChoiceControls(page);

  console.log('\n--- CHECKBOX AND RADIO DETAILS ---');
  console.log(JSON.stringify(choices, null, 2));

  const clickableElements = await page.locator(
    'button, a, input[type="button"], input[type="submit"], [role="button"]'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return {
        visible: (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        ),
        tag: element.tagName,
        type: element.type || '',
        id: element.id || '',
        name: element.name || '',
        text: (element.innerText || '').trim(),
        value: element.value || '',
        href: element.getAttribute('href'),
        disabled: element.disabled || false,
        className: typeof element.className === 'string'
          ? element.className
          : '',
        html: element.outerHTML.slice(0, 2000)
      };
    });
  });

  console.log('\n--- CHECKOUT BUTTONS AND CLICKABLE ELEMENTS ---');
  console.log(JSON.stringify(clickableElements, null, 2));

  const questionGroups = await page.locator(
    'fieldset, .form-group, .form-check, .checkbox, .radio, .question'
  ).evaluateAll(elements => {
    return elements
      .map(element => ({
        tag: element.tagName,
        id: element.id || '',
        className: typeof element.className === 'string'
          ? element.className
          : '',
        text: (element.innerText || '').trim().slice(0, 2000),
        html: element.outerHTML.slice(0, 3000)
      }))
      .filter(item => item.text.length > 0);
  });

  console.log('\n--- CHECKOUT QUESTION GROUPS ---');
  console.log(JSON.stringify(questionGroups, null, 2));

  await page.screenshot({
    path: 'providerxx-checkout-detailed-inspection.png',
    fullPage: true
  });

  console.log('\nCheckout inspection screenshot saved.');
}

// Inspect the actual ProviderXX checkout iframe.
async function inspectProviderCheckoutFrame(page) {
  console.log('\n========================================');
  console.log('PROVIDER CHECKOUT IFRAME INSPECTION');
  console.log('========================================');

  const iframeElement = page.locator('#checkoutContent');

  await iframeElement.waitFor({
    state: 'visible',
    timeout: 15000
  });

  console.log('\n--- IFRAME ELEMENT DETAILS ---');

  const iframeDetails = await iframeElement.evaluate(element => ({
    id: element.id,
    name: element.name,
    src: element.src,
    title: element.title,
    visible: element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0
  }));

  console.log(JSON.stringify(iframeDetails, null, 2));

  const checkoutFrame = page.frameLocator('#checkoutContent');
  const frameBody = checkoutFrame.locator('body');

  await frameBody.waitFor({
    state: 'visible',
    timeout: 15000
  });

  console.log('\n--- IFRAME PAGE TEXT ---');

  const iframeText = await frameBody.innerText();

  console.log(iframeText.slice(0, 20000));

  console.log('\n--- IFRAME VISIBLE CONTROLS ---');

  const iframeControls = await checkoutFrame.locator(
    'input, button, select, textarea, a'
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

        if (label) {
          labels.push(label.innerText.trim());
        }
      }

      const parentLabel = element.closest('label');

      if (parentLabel) {
        labels.push(parentLabel.innerText.trim());
      }

      return [...new Set(labels.filter(Boolean))].join(' | ');
    };

    return elements
      .filter(isVisible)
      .map(element => ({
        tag: element.tagName,
        type: element.type || '',
        id: element.id || '',
        name: element.name || '',
        label: getLabel(element),
        placeholder: element.placeholder || '',
        value: element.value || '',
        text: (element.innerText || '').trim(),
        checked: element.checked ?? undefined,
        disabled: element.disabled || false,
        html: element.outerHTML.slice(0, 1500)
      }));
  });

  console.log(JSON.stringify(iframeControls, null, 2));

  console.log('\n--- IFRAME CHECKBOXES AND RADIO BUTTONS ---');

  const iframeChoices = await checkoutFrame.locator(
    'input[type="checkbox"], input[type="radio"]'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      let parent = element.parentElement;
      let surroundingText = '';

      for (let i = 0; i < 5 && parent; i++) {
        surroundingText = (parent.innerText || '').trim();

        if (surroundingText.length > 0) {
          break;
        }

        parent = parent.parentElement;
      }

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

        if (label) {
          labelText = label.innerText.trim();
        }
      }

      if (!labelText) {
        const parentLabel = element.closest('label');

        if (parentLabel) {
          labelText = parentLabel.innerText.trim();
        }
      }

      return {
        visible: (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        ),
        type: element.type,
        id: element.id,
        name: element.name,
        value: element.value,
        label: labelText,
        checked: element.checked,
        disabled: element.disabled,
        surroundingText: surroundingText.slice(0, 1500),
        html: element.outerHTML.slice(0, 1000)
      };
    });
  });

  console.log(JSON.stringify(iframeChoices, null, 2));

  console.log('\n--- IFRAME FORMS ---');

  const iframeForms = await checkoutFrame.locator(
    'form'
  ).evaluateAll(forms =>
    forms.map(form => ({
      id: form.id,
      name: form.name,
      action: form.getAttribute('action'),
      method: form.method,
      text: (form.innerText || '').trim().slice(0, 3000),
      visible: form.getBoundingClientRect().width > 0 &&
        form.getBoundingClientRect().height > 0
    }))
  );

  console.log(JSON.stringify(iframeForms, null, 2));

  console.log('\n--- IFRAME NAVIGATION CONTROLS ---');

  const navigationElements = await checkoutFrame.locator(
    'input, button, a, [role="button"]'
  ).evaluateAll(elements => {
    return elements.map(element => {
      const rect = element.getBoundingClientRect();

      return {
        tag: element.tagName,
        type: element.type || '',
        id: element.id || '',
        name: element.name || '',
        value: element.value || '',
        text: (element.innerText || '').trim(),
        className: typeof element.className === 'string'
          ? element.className
          : '',
        visible: rect.width > 0 && rect.height > 0,
        disabled: element.disabled || false,
        href: element.getAttribute('href'),
        html: element.outerHTML.slice(0, 1500)
      };
    }).filter(element =>
      /forward|next|continue|confirm|submit|checkout/i.test(
        `${element.id} ${element.name} ${element.value} ${element.text}`
      )
    );
  });

  console.log(JSON.stringify(navigationElements, null, 2));

  await page.screenshot({
    path: 'providerxx-checkout-iframe-inspection.png',
    fullPage: true
  });

  console.log('\nProvider checkout iframe screenshot saved.');
  console.log('\nIFRAME INSPECTION COMPLETED.');
}

async function main() {
  const cfg = getConfig();

  const browser = await launchBrowser(cfg.headless);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Opening AllConnect portal...');

    await page.goto(cfg.portalUrl, {
      waitUntil: 'domcontentloaded'
    });

    console.log('Starting authentication...');

    await login(page, cfg);

    // STEP 1: BASIC INFORMATION

    console.log('\n--- BASIC INFORMATION ---');

    await inspectBasicInformation(page);

    console.log('\nFilling Basic Information with dummy data...');

    await fillBasicInformation(page, dummyCustomer);

    console.log('Basic Information verified.');

    console.log('Navigating to the next page...');

    await page.locator('#basicInfoForward').click();

    await page.waitForTimeout(2000);

    // STEP 2: VALID ADDRESS PAGE

    await inspectPage(
      page,
      'VALID ADDRESS PAGE',
      'next-page-inspection.png'
    );

    console.log('\nProceeding from address validation...');

    const addressForward = page.locator('#addressFoundForward');

    await addressForward.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await addressForward.click();

    await page.waitForTimeout(2500);

    // STEP 3: QUALIFICATION PAGE

    await inspectPage(
      page,
      'QUALIFICATION PAGE',
      'following-page-inspection.png'
    );

    // STEP 4: SELECT NEW CUSTOMER

    console.log('\nSelecting New customer...');

    const newRadio = page.locator(
      '#selection_display #BOOL_New_DF_Scripted_Qual_CL_11'
    );

    await newRadio.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await newRadio.check();

    const isNewSelected = await newRadio.isChecked();

    console.log('New customer selected:', isNewSelected);

    if (!isNewSelected) {
      throw new Error(
        'New customer radio button was not selected.'
      );
    }

    const transferRadio = page.locator(
      '#selection_display #BOOL_Transfer_DF_Scripted_Qual_CL_11'
    );

    console.log(
      'Transfer customer selected:',
      await transferRadio.isChecked()
    );

    // STEP 5: PROCEED TO RECOMMENDATIONS

    console.log('\nClicking Qualification Forward...');

    const qualificationForward = page.locator(
      '#qualificationForward'
    );

    await qualificationForward.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await qualificationForward.click();

    await page.waitForTimeout(2500);

    // STEP 6: RECOMMENDATIONS PAGE

    await inspectPage(
      page,
      'RECOMMENDATIONS PAGE',
      'recommendations-inspection.png'
    );

    // STEP 7: OPEN INTERNET CATEGORY

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

    // STEP 8: INTERNET OFFERS PAGE

    await inspectPage(
      page,
      'INTERNET OFFERS PAGE',
      'internet-offers-inspection.png'
    );

    // STEP 9: INSPECT PROVIDERXX PLAN CARDS

    console.log('\n--- PROVIDERXX PLAN CARD DETAILS ---');

    const providerXXButtons = page.locator(
      'input.ViewDetailsBtn[id*="_RTS:PROVIDERXX:"]'
    );

    const buttonCount = await providerXXButtons.count();

    console.log(`Found ${buttonCount} ProviderXX plans.`);

    const providerPlans = [];

    for (let i = 0; i < buttonCount; i++) {
      const button = providerXXButtons.nth(i);

      const details = await button.evaluate(element => {
        let parent = element;

        for (let level = 0; level < 7 && parent; level++) {
          const text = (parent.innerText || '').trim();

          if (
            text.length > 30 &&
            /ProviderXX/i.test(text)
          ) {
            const hiddenJson = parent.querySelector(
              '.singleHiddenJson'
            );

            return {
              containerTag: parent.tagName,
              containerId: parent.id,
              containerClass: typeof parent.className === 'string'
                ? parent.className
                : '',
              text,
              hiddenJson: hiddenJson
                ? hiddenJson.getAttribute('value')
                : null,
              html: parent.outerHTML.slice(0, 5000)
            };
          }

          parent = parent.parentElement;
        }

        return {
          text: '',
          hiddenJson: null,
          html: element.parentElement?.outerHTML || ''
        };
      });

      const plan = {
        buttonId: await button.getAttribute('id'),
        ...details
      };

      providerPlans.push(plan);

      console.log(`\nPLAN ${i + 1}`);
      console.log(JSON.stringify(plan, null, 2));
    }

    // STEP 10: IDENTIFY THE EXACT 300 MBPS ONE-YEAR PLAN

    console.log(
      '\n--- IDENTIFYING PROVIDERXX 300 MBPS ONE-YEAR PLAN ---'
    );

    const targetPlanIndex = providerPlans.findIndex(plan => {
      const text = plan.text || '';

      let json = {};

      try {
        json = JSON.parse(plan.hiddenJson || '{}');
      } catch {
        return false;
      }

      const providerMatches =
        /ProviderXX/i.test(text) &&
        /ProviderXX/i.test(json.providerName || '');

      const productName = json.productname || '';

      const speedMatches =
        /300\s*Mbps/i.test(text) &&
        /300\s*Mbps/i.test(productName);

      const oneYearMatches =
        /1\s*[- ]?\s*year/i.test(text) ||
        /1\s*[- ]?\s*year/i.test(productName);

      const priceMatches =
        /\$40\.00/.test(text) &&
        /^\$?40(?:\.00)?$/.test(
          String(json.recuring || '').replace(/,/g, '').trim()
        );

      return (
        providerMatches &&
        speedMatches &&
        oneYearMatches &&
        priceMatches
      );
    });

    if (targetPlanIndex === -1) {
      throw new Error(
        'Could not identify the exact ProviderXX 300 Mbps one-year plan at $40.00. No plan will be added.'
      );
    }

    const targetPlanDetails = providerPlans[targetPlanIndex];

    console.log('\nExact target plan identified:');

    console.log(
      JSON.stringify(targetPlanDetails, null, 2)
    );

    const expectedButtonId =
      'product_15501641_RTS:PROVIDERXX:9626102630:NED';

    if (targetPlanDetails.buttonId !== expectedButtonId) {
      throw new Error(
        'The identified plan button ID does not match the previously verified product. Stopping for safety.'
      );
    }

    const exactButton = page.locator(
      'input.ViewDetailsBtn[id="product_15501641_RTS:PROVIDERXX:9626102630:NED"]'
    );

    await exactButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const card = exactButton.locator(
      'xpath=ancestor::*[contains(@class,"singleProductContent")][1]'
    );

    const cardText = await card.innerText();

    const hiddenJsonValue = await card.locator(
      '.singleHiddenJson'
    ).getAttribute('value');

    let planData = {};

    try {
      planData = JSON.parse(hiddenJsonValue || '{}');
    } catch {
      throw new Error(
        'Could not verify the selected plan JSON.'
      );
    }

    console.log('\n--- FINAL PLAN CARD VERIFICATION ---');

    console.log('Provider:', planData.providerName);
    console.log('Product:', planData.productname);
    console.log('Price:', planData.recuring);
    console.log('Button ID:', targetPlanDetails.buttonId);

    if (
      !/ProviderXX/i.test(planData.providerName || '') ||
      !/300\s*Mbps/i.test(planData.productname || '') ||
      !/1\s*[- ]?\s*year/i.test(planData.productname || '') ||
      !/^\$?40(?:\.00)?$/.test(
        String(planData.recuring || '').trim()
      ) ||
      !/300\s*Mbps/i.test(cardText) ||
      !/1\s*[- ]?\s*year/i.test(cardText) ||
      !/\$40\.00/.test(cardText)
    ) {
      throw new Error(
        'Final plan verification failed. The plan will not be opened.'
      );
    }

    console.log('\nExact ProviderXX plan card verified.');

    // STEP 11: OPEN VIEW DETAILS

    console.log(
      '\nOpening View Details for ProviderXX 300 Mbps one-year plan...'
    );

    await exactButton.click();

    await page.waitForTimeout(2000);

    await inspectPage(
      page,
      'PROVIDERXX 300 MBPS PLAN DETAILS',
      'providerxx-plan-details.png'
    );

    // STEP 12: VERIFY PRODUCT DETAILS

    console.log('\n--- VERIFYING PRODUCT DETAILS ---');

    const detailText = await page.locator('body').innerText();

    const expectedDetails = [
      /300 Mbps \(1-YEAR PRICING\)/i,
      /BASE MONTHLY PRICE:\s*\$40\.00/i,
      /BASE INSTALLATION PRICE:\s*\$0\.00/i
    ];

    for (const pattern of expectedDetails) {
      if (!pattern.test(detailText)) {
        throw new Error(
          `Product details verification failed: ${pattern}. Stopping before adding the plan.`
        );
      }
    }

    console.log('Product name verified.');
    console.log('Monthly base price verified: $40.00.');
    console.log('Installation base price verified: $0.00.');

    // STEP 13: VERIFY ADD TO ORDER CONTROL

    const addToOrderButton = page.locator(
      '#AddToOrderBtn2'
    );

    await addToOrderButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const addToOrderValue = await addToOrderButton.inputValue();

    console.log('\nAdd to Order control:', addToOrderValue);

    if (!/Add to Order/i.test(addToOrderValue)) {
      throw new Error(
        'The expected Add to Order control was not verified.'
      );
    }

    // STEP 14: ADD THE VERIFIED PLAN TO THE ORDER

    console.log(
      '\nAdding the verified ProviderXX plan to the order...'
    );

    await addToOrderButton.click();

    await page.waitForTimeout(2500);

    // STEP 15: VERIFY SHOPPING CART

    console.log('\n--- SHOPPING CART VERIFICATION ---');

    const cartText = await page.locator('body').innerText();

    console.log(cartText.slice(-10000));

    await page.screenshot({
      path: 'providerxx-plan-added-to-order.png',
      fullPage: true
    });

    const cartHasPlan =
      /300\s*Mbps/i.test(cartText) &&
      /1-YEAR PRICING/i.test(cartText) &&
      /\$40\.00/.test(cartText);

    if (!cartHasPlan) {
      throw new Error(
        'Cart verification failed. The expected ProviderXX 300 Mbps one-year plan at $40.00 was not confirmed. Checkout will not be opened.'
      );
    }

    console.log(
      '\nProviderXX 300 Mbps one-year plan found in the cart.'
    );

    console.log('Displayed price: $40.00.');

    // STEP 16: VERIFY CHECKOUT CONTROL

    const checkoutButton = page.locator(
      '#checkoutItems'
    );

    await checkoutButton.waitFor({
      state: 'visible',
      timeout: 15000
    });

    const checkoutValue = await checkoutButton.inputValue();

    console.log('\nCheckout control:', checkoutValue);

    if (!/Checkout/i.test(checkoutValue)) {
      throw new Error(
        'Expected Checkout control was not verified.'
      );
    }

    // STEP 17: OPEN CHECKOUT

    console.log('\nOpening checkout...');

    await checkoutButton.click();

    await page.waitForTimeout(2500);

    // STEP 18: INSPECT OUTER CHECKOUT PAGE

    await inspectCheckout(page);

    // STEP 19: INSPECT PROVIDERXX CHECKOUT IFRAME

    await inspectProviderCheckoutFrame(page);

    // STEP 20: STOP AFTER INSPECTION

    console.log('\n========================================');
    console.log('AUTOMATION CHECKPOINT');
    console.log('========================================');

    console.log('Login completed.');
    console.log('Basic Information completed.');
    console.log('Address validation completed.');
    console.log('Qualification completed.');
    console.log('Internet category opened.');
    console.log('ProviderXX plan verified.');
    console.log('Plan added to the cart.');
    console.log('Checkout page opened.');
    console.log('Provider checkout iframe inspected.');

    console.log('\nNo additional checkout selections were made.');
    console.log('No customer identity details were entered.');
    console.log('No installation confirmation was clicked.');

    console.log('\nCHECKOUT INSPECTION COMPLETED.');

  } catch (error) {
    console.error('\nAutomation failed:', error.message);

    console.log('Current URL:', page.url());

    await page.screenshot({
      path: 'automation-error.png',
      fullPage: true
    }).catch(() => {});

    process.exitCode = 1;

  } finally {
    await context.close();
    await browser.close();
  }
}

main();
