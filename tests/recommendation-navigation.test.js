const { test, expect } = require('@playwright/test');
const { openInternetOffers } = require('../src/main');

async function setupRecommendationsPage(page, { transitionOnClick = 1 } = {}) {
  await page.route('https://simulator.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <title>Recommendations</title>
      <a href="#" data-ac-href="/salescenter?CategoryName=INTERNET">Internet</a>
      <input class="ViewDetailsBtn" type="button" value="View Details" hidden>
      <script>
        window.categoryClicks = 0;
        document.querySelector('a').addEventListener('click', event => {
          event.preventDefault();
          window.categoryClicks += 1;
          if (window.categoryClicks === ${transitionOnClick}) {
            history.pushState({}, '', '/allconnect/recommendations/internet/');
            document.querySelector('.ViewDetailsBtn').hidden = false;
          }
        });
      </script>`
  }));
  await page.goto('https://simulator.test/allconnect/recommendations/');
}

test('Internet category waits for the route and offers control after one click', async ({ page }) => {
  await setupRecommendationsPage(page);

  await openInternetOffers(page, { transitionTimeout: 100, offersTimeout: 5000 });

  await expect(page).toHaveURL(/\/allconnect\/recommendations\/internet\/$/);
  await expect(page.locator('input.ViewDetailsBtn')).toBeVisible();
  expect(await page.locator('a[data-ac-href*="CategoryName=INTERNET"]').count()).toBe(1);
});

test('retries a no-op category click only while still on Recommendations', async ({ page }) => {
  await setupRecommendationsPage(page, { transitionOnClick: 2 });

  await openInternetOffers(page, { transitionTimeout: 100, offersTimeout: 5000 });

  await expect(page).toHaveURL(/\/allconnect\/recommendations\/internet\/$/);
  expect(await page.locator('.ViewDetailsBtn').isVisible()).toBe(true);
  expect(await page.evaluate(() => window.categoryClicks)).toBe(2);
});

test('does not click the category again after the offers route has already loaded', async ({ page }) => {
  await setupRecommendationsPage(page);
  await page.locator('a').click();
  await expect(page).toHaveURL(/\/allconnect\/recommendations\/internet\/$/);

  const clicksBefore = await page.evaluate(() => window.categoryClicks);
  await openInternetOffers(page, { transitionTimeout: 500, offersTimeout: 5000 });
  const clicksAfter = await page.evaluate(() => window.categoryClicks);

  expect(clicksAfter).toBe(clicksBefore);
  expect(clicksAfter).toBe(1);
  await expect(page.locator('.ViewDetailsBtn')).toBeVisible();
});
