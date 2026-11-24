'use strict';

const { test, expect } = require('@playwright/test');
const { completeDemoCheckout } = require('../src/main');
const { SENSITIVE_TTL_MS } = require('../src/sensitiveInput');

// Explicit opt-in for this isolated Playwright demo fixture only.
process.env.ALLOW_DEMO_ORDER_SUBMISSION = 'true';

function makeSensitivePayment() {
  const now = Date.now();
  return {
    version: 1,
    issuedAt: now,
    expiresAt: now + SENSITIVE_TTL_MS,
    scenario: 'ez-enroll-card',
    payment: {
      cardHolderName: 'Demo Test',
      cardNumber: '4242424242424242',
      expirationMonth: '12',
      expirationYear: String(new Date(now).getFullYear() + 2),
      cvv: '123'
    }
  };
}

async function installPortalFixture(page) {
  const paymentMarkup = `
    <div class="box tinted">
      <p>To confirm the card has sufficient funds, please read and acknowledge.</p>
      <label class="m-read"><input type="checkbox" id="paymentRead">Read</label>
    </div>
    <label><input type="radio" name="addcard" value="new">Add a new credit card</label>
    <input class="cbtn secure" type="button" value="Edit Secure Fields">
    <div id="secureFields" style="display:none">
      <label for="cardType">Card Type:</label>
      <select id="cardType"><option value="">**********</option><option value="visa">Visa</option><option value="mastercard">MasterCard</option><option value="amex">American Express</option><option value="discover">Discover</option></select>
      <label for="cardNumber">Card Number:</label><input id="cardNumber" aria-label="Card Number" value="">
      <label for="cardHolder">Card Holder Name:</label><input id="cardHolder" aria-label="Card Holder Name" value="">
      <label for="cvv">CVV Code:</label><input id="cvv" aria-label="CVV Code" value="">
      <label for="expiryMonth">Expiration month:</label><input id="expiryMonth" aria-label="Expiration month" value="">
      <label for="expiryYear">Expiration year:</label><input id="expiryYear" aria-label="Expiration year" value="">
    </div>
    <p>Is the credit card billing address the same as service address?</p>
    <label><input type="radio" name="billing" value="yes">Yes</label>
    <label><input type="radio" name="billing" value="no">No</label>
    <input id="forward" class="cbtn" type="button" value="Forward >">
  `;

  await page.route('https://portal.example.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><iframe id="checkoutContent" src="/checkout/"></iframe></body></html>'
      });
      return;
    }
    if (pathname === '/checkout/') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>
          <h3>ORDER QUALIFICATION STATUS</h3>
          <label><input type="radio" name="itype" value="STANDARD_SHIPPING">STANDARD SHIPPING - (Free)</label>
          <label><input type="radio" name="itype" value="PRO_INSTALL">PRO_INSTALL - (install:$100.00)</label>
          <button id="confirmInstallation" type="button">Confirm Installation &gt;</button>
          <button id="forward" type="button">Forward &gt;</button>
          <script>
            window.parent.__confirmClickCount = 0;
            window.parent.__forwardClickCount = 0;
            document.querySelector('#confirmInstallation').addEventListener('click', () => {
              window.parent.__confirmClickCount++;
            });
            document.querySelector('#forward').addEventListener('click', () => {
              window.parent.__forwardClickCount++;
              document.body.innerHTML = ${JSON.stringify(paymentMarkup)};
              document.querySelector('.secure').addEventListener('click', () => {
                document.querySelector('#secureFields').style.display = 'block';
              });
              document.querySelector('#forward').addEventListener('click', () => {
                window.parent.__submittedPayment = {
                  cardType: document.querySelector('#cardType').value,
                  cardNumber: document.querySelector('[aria-label="Card Number"]').value,
                  cardHolderName: document.querySelector('[aria-label="Card Holder Name"]').value,
                  month: document.querySelector('[aria-label="Expiration month"]').value,
                  year: document.querySelector('[aria-label="Expiration year"]').value,
                  cvv: document.querySelector('[aria-label="CVV Code"]').value,
                  billing: document.querySelector('input[name="billing"]:checked')?.value
                };
                window.parent.__forwardClickCount++;
                document.body.innerHTML = '<label class="m-read"><input type="checkbox" id="finalRead">Read final authorization</label><button id="submitOrder" type="button">Submit Order</button>';
                document.querySelector('#submitOrder').addEventListener('click', () => {
                  history.pushState({}, '', '/allconnect-frame/order-summary/');
                  document.title = 'Order Summary';
                  document.body.innerHTML = '<h1>Order Summary</h1><div class="summary"><div class="item">Demo order completed</div><div>CHECKOUT_COMPLETED</div></div>';
                });
              });
            });
          </script>
        </body></html>`
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto('https://portal.example.test/');
}

function makeInput(sensitiveData = makeSensitivePayment()) {
  return {
    customer: { firstName: 'Demo', lastName: 'Test' },
    plan: { provider: 'ProviderXX', monthlyPrice: 40, installationPrice: 0 },
    accountHolder: { ezEnroll: true },
    installation: { type: 'standard_shipping' },
    sensitiveData,
    paymentOptions: { cardType: 'Visa', billingAddressSameAsService: true },
    execution: { mode: 'demo', stopBeforeFinalOrderSubmission: false, submitDemoOrder: true }
  };
}

test('EZ-Enroll Yes selects card type, fills synthetic card, acknowledges authorization, and stops at Order Summary', async ({ page }) => {
  await installPortalFixture(page);
  await page.evaluate(() => {
    window.__confirmClickCount = 0;
    window.__forwardClickCount = 0;
  });

  const result = await completeDemoCheckout(page, makeInput());
  expect(result.payment.cardDetailsEntered).toBe(true);
  expect(result.payment.forwardClicked).toBe(true);
  expect(result.orderSummaryReached).toBe(true);
  expect(result.finalOrderSubmitted).toBe(false);
  expect(result.placeOrderClicked).toBe(false);
  expect(result.payment.performed).toBe(false);

  const submitted = await page.evaluate(() => window.__submittedPayment);
  expect(submitted.cardType).toBe('visa');
  expect(submitted.billing).toBe('yes');
  expect(submitted.cardNumber).toBe('4242424242424242');
  expect(submitted.cardHolderName).toBe('Demo Test');
  expect(submitted.month).toBe('12');
  expect(submitted.year).toBe(String(new Date().getFullYear() + 2));
  expect(submitted.cvv).toBe('123');
  expect(await page.evaluate(() => window.__confirmClickCount)).toBe(1);
  expect(await page.evaluate(() => window.__forwardClickCount)).toBe(2);
  expect(result.payment.finalReadChecked).toBe(true);
  expect(result.payment.submitOrderClicked).toBe(true);
  expect(result.orderSummaryVerification.summaryVisible).toBe(true);
  expect(result.orderSummaryVerification.finalOrderSubmitted).toBe(false);
  expect(JSON.stringify(result)).not.toContain('4242424242424242');
});

test('expired EZ-Enroll card payload requests fresh details and stops at Order Summary', async ({ page }) => {
  await installPortalFixture(page);
  const expired = makeSensitivePayment();
  expired.expiresAt = Date.now() - 1;
  let refreshCount = 0;
  const input = makeInput(expired);
  input.paymentOptions = { cardType: 'MasterCard', billingAddressSameAsService: false };
  input.requestSensitiveRefresh = async () => {
    refreshCount += 1;
    return makeSensitivePayment();
  };

  const result = await completeDemoCheckout(page, input);
  expect(refreshCount).toBe(1);
  expect(result.orderSummaryReached).toBe(true);
  const submitted = await page.evaluate(() => window.__submittedPayment);
  expect(submitted.cardType).toBe('mastercard');
  expect(submitted.billing).toBe('no');
  expect(submitted.cardNumber).toBe('4242424242424242');
  expect(result.finalOrderSubmitted).toBe(false);
  expect(result.placeOrderClicked).toBe(false);
  expect(result.payment.performed).toBe(false);
  expect(result.payment.submitOrderClicked).toBe(true);
});





