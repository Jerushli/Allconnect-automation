const { test, expect } = require('@playwright/test');
const { selectInstallationOption } = require('../src/main');

async function checkoutFrameWithOptions(page) {
  await page.setContent('<iframe id="checkoutContent"></iframe>');
  const html = `
    <label><input type="radio" name="itype" value="STANDARD_SHIPPING"> STANDARD_SHIPPING - (Free)</label>
    <label><input type="radio" name="itype" value="PRO_INSTALL"> PRO_INSTALL - (install:$100.00)</label>
  `;
  await page.locator('#checkoutContent').evaluate((frame, content) => { frame.srcdoc = content; }, html);
  const frame = page.frameLocator('#checkoutContent');
  await frame.locator('input[name="itype"]').first().waitFor({ state: 'visible' });
  return frame;
}

test('standard shipping selection matches and verifies its displayed option', async ({ page }) => {
  const frame = await checkoutFrameWithOptions(page);
  const selected = await selectInstallationOption(frame, 'standard_shipping');
  expect(selected).toBe('STANDARD SHIPPING - (Free)');
  await expect(frame.locator('input[name="itype"]').nth(0)).toBeChecked();
  await expect(frame.locator('input[name="itype"]').nth(1)).not.toBeChecked();
});

test('professional installation selection matches and verifies its displayed option', async ({ page }) => {
  const frame = await checkoutFrameWithOptions(page);
  const selected = await selectInstallationOption(frame, 'professional_installation');
  expect(selected).toBe('PRO_INSTALL - (install:$100.00)');
  await expect(frame.locator('input[name="itype"]').nth(1)).toBeChecked();
  await expect(frame.locator('input[name="itype"]').nth(0)).not.toBeChecked();
});

test('unsupported installation selection fails without changing a radio option', async ({ page }) => {
  const frame = await checkoutFrameWithOptions(page);
  await expect(selectInstallationOption(frame, 'unrecognized')).rejects.toThrow(/Unsupported installation type/);
  await expect(frame.locator('input[name="itype"]').nth(0)).not.toBeChecked();
  await expect(frame.locator('input[name="itype"]').nth(1)).not.toBeChecked();
});
