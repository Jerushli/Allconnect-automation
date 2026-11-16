
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

  const javascriptResources =
    result.navigationInspection.javascriptResources;

  expect(Array.isArray(javascriptResources)).toBe(true);

  expect(
  result.navigationInspection.javascriptResourceCount
).toBeGreaterThanOrEqual(javascriptResources.length);

  expect(javascriptResources.length).toBeLessThanOrEqual(50);

  for (const resource of javascriptResources) {
    expect(resource).toEqual({
      sameOrigin: expect.any(Boolean),
      filename: expect.any(String)
    });

    expect(resource.filename).not.toContain('?');
    expect(resource.filename).not.toContain('#');
    expect(resource.filename).not.toContain('/');
  }

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

test('checkout resource inventory identifies JavaScript resources safely', async ({ page }) => {
  // Intercept a test-only portal origin. No real website is contacted.
  await page.route('https://portal.example.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === '/test') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <body>
              <iframe
                id="checkoutContent"
                src="/checkout"
              ></iframe>
            </body>
          </html>
        `
      });

      return;
    }

    if (pathname === '/checkout') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <!DOCTYPE html>
          <html>
            <body>
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
                window.performance.getEntriesByType = (type) => {
                  if (type !== 'resource') {
                    return [];
                  }

                  return [
                    {
                      name: 'https://portal.example.test/assets/app.js'
                    },
                    {
                      name: 'https://portal.example.test/assets/runtime.mjs'
                    },
                    {
                      name: 'https://cdn.example.test/vendor.js'
                    },
                    {
                      name: 'https://portal.example.test/assets/private.js?token=SECRET123'
                    },
                    {
                      name: 'https://portal.example.test/assets/styles.css'
                    }
                  ];
                };
              </script>
            </body>
          </html>
        `
      });

      return;
    }

    await route.fulfill({
      status: 404,
      body: 'Not found'
    });
  });

  // Navigate to the intercepted test origin.
  await page.goto('https://portal.example.test/test');

  const result = await completeDemoCheckout(page, {
    accountHolder: {},
    installation: {
      type: 'standard_shipping'
    }
  });

  expect(result.installation.verified).toBe(true);
  expect(result.stoppedSafely).toBe(true);
  expect(result.installation.confirmationClicked).toBe(false);
  expect(result.installation.confirmed).toBe(false);
  expect(result.orderSummaryReached).toBe(false);
  expect(result.finalOrderSubmitted).toBe(false);

  const resources = result.navigationInspection.javascriptResources;

  expect(Array.isArray(resources)).toBe(true);

  expect(resources).toEqual([
    {
      sameOrigin: true,
      filename: 'app.js'
    },
    {
      sameOrigin: true,
      filename: 'runtime.mjs'
    },
    {
      sameOrigin: false,
      filename: 'vendor.js'
    },
    {
      sameOrigin: true,
      filename: 'private.js'
    }
  ]);

  expect(
    result.navigationInspection.javascriptResourceCount
  ).toBe(4);

  // Sensitive query parameters must never appear in diagnostic output.
  expect(JSON.stringify(resources)).not.toContain('SECRET123');
  expect(JSON.stringify(resources)).not.toContain('token');

  // Confirm Installation and Forward must remain untouched.
  const confirmControl = result.navigationInspection.controls.find(
    control => control.text === 'Confirm Installation >'
  );

  expect(confirmControl).toBeTruthy();
  expect(confirmControl.type).toBe('button');
  expect(confirmControl.disabled).toBe(false);
});
