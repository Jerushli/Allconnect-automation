# AllConnect Internet Order Automation

Node.js and Playwright automation for the AllConnect simulated internet-order portal. The automation reads customer and order choices from JSON, validates them, navigates the simulator, and writes an execution report.

## Completion status

The project is **not yet complete** against the delivery definition. The latest live run (2026-11-13, scenario 04) safely stopped at the simulator's card-required payment page after confirming installation. It took 5,374 ms, entered no card details, did not advance, and did not reach Order Summary. The latest live EZ-Enroll No evidence remains the earlier run described below; it reached the Order Summary route without rendering the required heading and order fields, so the report recorded `orderSummaryReached: false`.

The six JSON files load and map, but only scenarios 04 and 06 have been run live recently. Scenarios 01, 02, 03, and 05 have not been verified end to end. Scenarios with EZ-Enroll No require available one-time encrypted SSN and DOB records. The checked-in references for scenarios 01 and 06 are unavailable, and scenarios 02, 03, and 05 have no identity record references.

Recent live evidence: scenario 04 stopped safely before card entry; scenario 06's simulator credit check approved and standard installation was confirmed. Scenario 06 then navigated to the Order Summary URL, but the heading, completion marker, and expected order fields did not render. The live Order Summary is therefore unverified. Scenario 04's preceding comparable run took 6,530 ms; this run was 1,156 ms faster (17.7%), but portal and network variability mean this is an observed timing difference, not an isolated benchmark of a single code change. The automated Order Summary tests use a controlled page fixture and are not proof of the live transition.

## Project overview

- Supports simulator login, customer/address entry, new or transfer qualification, provider/plan selection, checkout customizations, account-holder answers, EZ-Enroll/credit-check branching, and installation selection.
- Has a local JSON scenario runner and an authenticated Express API.
- Uses encrypted, authorized, one-time identity records for the local EZ-Enroll No workflow.
- Stops before payment details and final order submission. It does not submit a real order.

## Architecture

```text
Scenario JSON ──> scenarioRunner.js ──> orderMapper ──> validateInput
                                                    └──> main.js / Playwright
                                                             ├── portal pages
                                                             ├── checkout iframe
                                                             ├── sensitiveDataService (EZ-Enroll No)
                                                             └── execution report

HTTP client ──> Express server ──> Bearer token + input validation
                                  └──> orderMapper ──> main.js
```

- `src/main.js`: input validation and portal workflow, including checkout, credit check, installation, safe stop, and Order Summary evidence checks.
- `src/scenarioRunner.js`: lists, loads, maps, validates, and runs scenario JSON files.
- `src/orderMapper.js`: maps API order bodies into automation input; the API rejects identity and payment data.
- `src/server.js`: Express health and order endpoints, authentication, duplicate-run protection, and API errors.
- `src/basicInformation.js`, `src/auth.js`, `src/browser.js`, `src/config.js`: browser launch, portal authentication, and customer entry/configuration.
- `src/recovery.js`: error classification, bounded retry for safe navigation/waits, browser diagnostics, and masked failure screenshots.
- `src/encryption.js`, `src/sensitiveDataService.js`: AES-256-GCM record encryption, authorization, availability checks, and one-time record consumption.
- `test-data/scenarios/`: six checked-in scenario files. `tests/`: Playwright automated tests.

## Technology stack

- Node.js (CommonJS)
- Playwright and `@playwright/test`
- Express 5
- dotenv
- Node.js `crypto` for authenticated encryption, tokens, and record IDs

## Install and configure

From the project directory in PowerShell:

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Edit `.env` locally. Never commit or share it.

| Variable | Required | Use |
|---|---:|---|
| `PORTAL_URL` | Yes for browser runs | Simulator portal entry URL. |
| `PORTAL_PASSWORD` | Yes for browser runs | Simulator login password. |
| `PORTAL_USERNAME` | No | Present in the template/config, but the current login routine does not use it. |
| `HEADLESS` | No | `true` for headless; defaults to visible Chromium. |
| `API_PORT` | No | API port; defaults to `3000`. |
| `API_TOKEN` | For API | Bearer token. Without it, order requests receive HTTP 503. |
| `SENSITIVE_DATA_KEY` | For encrypted records | Base64 encoding of exactly 32 random bytes. |
| `SENSITIVE_DATA_ACCESS_TOKEN` | For EZ-Enroll No | Authorizes local sensitive-record access. |
| `AUTOMATION_DIAGNOSTICS` | No | Set to `true` to enable verbose page inspections and diagnostic screenshots. Defaults to off. |

Generate independent local keys without displaying customer data:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the first output for `SENSITIVE_DATA_KEY`; use a separate random value for `SENSITIVE_DATA_ACCESS_TOKEN` and another for `API_TOKEN`. Do not reuse these values across environments.

## Scenario runner

List scenarios and choose interactively:

```powershell
npm run scenario
```

Run by number (the current numeric order is listed by the runner):

```powershell
npm run scenario -- 1
```

Run by file name:

```powershell
npm run scenario -- scenario-04-ez-enroll.json
```

`npm start` runs the legacy `test-data/sample-order.json` path. That sample currently has EZ-Enroll No without identity references, so it is expected to stop with an identity-record validation error until valid encrypted references are provisioned. Use the scenario runner for normal work.

The runner reports the selected file, validation progress, and resulting status. A `stopped_safely` result is not a completed order and does not imply that Order Summary was reached.

## Adding a JSON scenario

Add a file named `scenario-NN-short-description.json` under `test-data/scenarios/`. The runner sorts filenames numerically; no source edit is needed for a new file. Keep all values in the scenario JSON rather than adding scenario-specific branches to `main.js`.

The current mapper and validator expect these sections and values:

```json
{
  "customer": {
    "firstName": "Demo",
    "middleInitial": "",
    "lastName": "Customer",
    "zipCode": "10001",
    "streetAddress": "123 Test Road",
    "unitType": "Apartment",
    "unitNumber": "1",
    "city": "Sample City",
    "state": "NY",
    "residenceType": "Apartment",
    "ownership": "Rent",
    "leadId": "DEMO-001",
    "moving": "No",
    "moveInDate": "",
    "prefix": "Mr",
    "phone": "2025550100",
    "email": "customer@example.test"
  },
  "customerType": "New",
  "provider": "ProviderXX",
  "speedMbps": 300,
  "videoBundle": false,
  "phoneService": false,
  "plan": {
    "term": "1-year",
    "monthlyPrice": 40,
    "installationPrice": 0
  },
  "accountHolder": {
    "isAccountHolder": true,
    "isExistingProviderCustomer": false,
    "ezEnroll": true,
    "automaticPayments": true,
    "readAcknowledgement": true,
    "mailingAddressSameAsService": true,
    "shippingAddressSameAsService": true
  },
  "execution": {
    "mode": "demo",
    "stopBeforeFinalOrderSubmission": true
  },
  "checkout": {
    "broadbandFactLabels": "not_requested",
    "broadbandFactLabelsRead": true,
    "equipment": "leased_gateway",
    "nowTv": false
  },
  "installation": {
    "type": "standard_shipping"
  }
}
```

Accepted values include `customerType`: `New` or `Transfer`; `checkout.broadbandFactLabels`: `requested` or `not_requested`; `checkout.equipment`: `leased_gateway` or `own_equipment`; and `installation.type`: `standard_shipping` or `professional_installation`. Set `customer.moving` to `Yes` only with a valid `moveInDate`. Account-holder answer fields must be booleans.

For EZ-Enroll No, add an `identity` object with only `ssnRecordId` and `dateOfBirthRecordId`. These must be UUIDs for available encrypted records created with the current local encryption key. Never put SSN or DOB plaintext in a JSON scenario. Records are single-use: after a run consumes them, create fresh records and update the scenario before another run.

## Encrypted identity workflow

The interactive helper accepts masked **synthetic simulator test values**, encrypts them, and prints only record IDs:

```powershell
node scripts/create-sensitive-records.js
```

Copy the returned IDs into the local scenario's `identity` section. The automation authorizes both purposes through `SENSITIVE_DATA_ACCESS_TOKEN`, checks both record references before consumption, and consumes each record through `sensitiveDataService`. Consumed records are deleted even if the consumer fails. Do not retry with the same IDs; inspect availability and provision fresh records instead.

The HTTP API does not accept identity or payment sections. Because EZ-Enroll No needs identity references, the API is not a supported path for that branch. Use the local scenario runner for EZ-Enroll No.

## API startup and usage

Start the API in one terminal:

```powershell
npm run api
```

Check health (no authorization required):

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Submit a demo order from another terminal using a JSON payload that satisfies `src/orderMapper.js` and `src/main.js` validation:

```powershell
$tokenLine = Select-String -Path .\.env -Pattern '^API_TOKEN=' | Select-Object -First 1
$apiToken = $tokenLine.Line.Substring(10).Trim('"')
$headers = @{ Authorization = "Bearer $apiToken" }
$order = Get-Content -Raw .\test-data\sample-order.json | ConvertFrom-Json
$order.accountHolder.ezEnroll = $true
$body = $order | ConvertTo-Json -Depth 20
Invoke-RestMethod -Uri http://localhost:3000/api/orders `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

The API requires a valid Bearer token, rejects payment/identity fields, rejects invalid orders before launching the browser, and rejects concurrent requests with HTTP 409. It returns a status and safety checkpoint. The checked-in sample order has `ezEnroll: false` but no identity references, so it is not currently runnable end to end through either the API or local runner without valid records. For API smoke tests, use a test order with `accountHolder.ezEnroll` set to `true`; the simulator may still stop safely at its card-required payment screen.

Expected error statuses include 400 (invalid JSON/order), 401 (missing or incorrect bearer token), 409 (another run is active), 413 (body over 32 KB), 500 (automation/server error), and 503 (API token not configured).

## Error handling and recovery

`src/recovery.js` classifies common input, authentication, navigation, locator, iframe, API, credit-check, installation, simulator, and browser errors. Failures capture safe browser context and a screenshot with form inputs masked. Navigation and checkout iframe waits have bounded retries; the destination/state is checked before replay.

Actions with possible side effects—including clicks, credit checks, and sensitive-data consumption—are not blindly retried. Validation and authentication errors stop the run. A failure report does not indicate that a step succeeded; check the recorded step and state evidence.

Set `AUTOMATION_DIAGNOSTICS=true` to restore page inspection logs and intermediate diagnostic screenshots during a run.

## Reports and screenshots

- Execution reports: `reports/execution-report-<timestamp>.json`.
- Diagnostic and failure screenshots: project root (for example, `automation-error.png` and `providerxx-*.png`). Intermediate screenshots are enabled with `AUTOMATION_DIAGNOSTICS=true`; failure screenshots are captured when possible.
- Playwright test artifacts: `test-results/` and `playwright-report/`.

Reports record safe-stop status, credit/installation/payment checkpoints, Order Summary evidence, and whether final submission occurred. Review `orderSummaryReached` and its verification evidence; a route change alone is insufficient.

## Troubleshooting

- **`PORTAL_URL missing` / login timeout:** check `.env`, portal availability, and approved simulator credentials. `PORTAL_USERNAME` is currently not used by `auth.js`; the login flow waits for the password field.
- **API returns 503:** set `API_TOKEN` and restart `npm run api`.
- **API returns 401:** send `Authorization: Bearer <API_TOKEN>`.
- **API returns 400:** inspect the returned validation message and scenario JSON values.
- **EZ-Enroll No reports unavailable/consumed records:** create fresh encrypted records, confirm the key/token match those used to create them, and update both UUID references.
- **Order Summary URL but no summary evidence:** check the report for its heading, title, completion marker, and expected summary fields. The latest live run reached the summary URL but did not render those fields, so it remains unverified.
- **Run tests:** `npm test`. Check changed JavaScript syntax with `node --check <file>`.

## Tests

```powershell
npm test
```

The current suite covers API behavior, scenario mapping and dispatch, EZ-Enroll logic, encrypted-record handling, installation-option selection, recovery behavior, and Order Summary verification using a controlled page fixture. These tests do not constitute live end-to-end execution of all six scenarios.

Run the encryption round-trip/tamper check with generated ephemeral fixtures (requires `SENSITIVE_DATA_KEY`):

```powershell
node scripts/test-encryption.js
```

## Safety restrictions

- Use the authorized simulator and synthetic test customer data only.
- Never enter real SSN, DOB, payment-card data, or production credentials into test scenarios.
- Never bypass API authentication, sensitive-data authorization, or portal validation.
- Do not repeat consumed sensitive-record IDs.
- Do not enter payment card details, click payment submission, or submit a real order.
- The target checkpoint is a genuinely verified Order Summary page. The automation must stop there and must never click a final order submission control.
