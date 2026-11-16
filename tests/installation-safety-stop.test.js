
const { test, expect } = require('@playwright/test');
const { completeDemoCheckout } = require('../src/main');

test('demo checkout stops before Confirm Installation and Forward', async ({ page }) => {
  await page.setContent('<iframe id="checkoutContent"></iframe>');

  const html = `
    <label>
      <input type="radio" name="itype" value="STANDARD_SHIPPING">
      STANDARD SHIPPING - (Free)
    </label>

    <label>
      <input type="radio" name="itype" value="PRO_INSTALL">
      PRO_INSTALL - (install:$100.00)
    </label>

    <button id="confirmInstallation" type="button">
      Confirm Installation &gt;
    </button>

    <button id="forward" type="button">
      Forward &gt;
    </button>

    <script>
      document.querySelector('#confirmInstallation').addEventListener('click', () => {
        window.parent.__confirmClickCount++;
      });

      document.querySelector('#forward').addEventListener('click', () => {
        window.parent.__forwardClickCount++;
      });
    </script>
  `;

  await page.evaluate(() => {
    window.__confirmClickCount = 0;
    window.__forwardClickCount = 0;
  });

  await page.locator('#checkoutContent').evaluate((frame, content) => {
    frame.srcdoc = content;
  }, html);

  const result = await completeDemoCheckout(page, {
    accountHolder: {},
    installation: {
      type: 'standard_shipping'
    }
  });

  // Installation selection must be verified.
  expect(result.installation.verified).toBe(true);

  // Confirm Installation must not be clicked or confirmed.
  expect(result.installation.confirmationClicked).toBe(false);
  expect(result.installation.confirmed).toBe(false);

  // The workflow must stop safely.
  expect(result.stoppedSafely).toBe(true);
  expect(result.orderSummaryReached).toBe(false);
  expect(result.finalOrderSubmitted).toBe(false);

  // Read-only navigation inspection must be captured.
  expect(result.navigationInspection).toBeTruthy();

  const confirmControl = result.navigationInspection.controls.find(
    control => control.text === 'Confirm Installation >'
  );

  expect(confirmControl).toBeTruthy();
  expect(confirmControl.tag).toBe('BUTTON');
  expect(confirmControl.type).toBe('button');
  expect(confirmControl.disabled).toBe(false);
  expect(confirmControl.insideForm).toBe(false);
  expect(confirmControl.formDetails).toBeNull();
  expect(confirmControl.formActionPresent).toBe(false);
  expect(confirmControl.inlineOnclickPresent).toBe(false);

  // Neither button may have been clicked.
  expect(await page.evaluate(() => window.__confirmClickCount)).toBe(0);
  expect(await page.evaluate(() => window.__forwardClickCount)).toBe(0);
});
