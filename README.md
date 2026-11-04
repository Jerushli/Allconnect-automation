# AllConnect Internet Order Automation — Starter

Local Node.js + Playwright framework for an authorized simulated portal.

## Current scope
Scaffold includes config, local Chromium launch, synthetic order data, tests, and observed screen notes. Basic Information and Qualification are screenshot-documented, but DOM selectors are not yet confirmed. Login, product selection, credit/payment, installation, checkout are not implemented. This does not submit orders.

## Setup (Windows PowerShell)
```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```
Set the internal portal URL and approved test credentials locally in `.env`. Do not share or commit it.

## Check and launch
```powershell
npm test
npm start
```
Set `HEADLESS=true` for headless mode; false opens visible Chromium. Use approved mock profiles only, never real customer SSNs.

## Next
Inspect login DOM, map stable selectors for Basic Information and Qualification, then inspect each subsequent stage before implementing branching and checkout. Verify confirmation before marking a run successful.
