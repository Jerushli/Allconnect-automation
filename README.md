# AllConnect Internet Order Automation

Node.js and Playwright automation for the AllConnect simulated internet-order portal. Scenario JSON controls the customer, qualification, provider, plan, checkout customizations, account-holder answers, and installation choice. SSN, DOB, and simulator test-card details are collected interactively at run time and are never stored in scenario JSON.

## Current completion boundary

The protected demo workflow runs through the simulator's final authorization step and stops at a verified **Order Summary**. The scenario's `execution.submitDemoOrder: true` and the local `ALLOW_DEMO_ORDER_SUBMISSION=true` setting are both required only to click the simulator's `Submit Order` control that transitions to the summary page. This is a simulator UI transition, not a real order submission. The automation does not click a separate Place Order control, does not process a real payment, does not confirm a real installation, and always reports `finalOrderSubmitted: false`. The report keeps `orderSummaryReached`, `placeOrderClicked`, `paymentPerformed`, `installationConfirmed`, and `finalOrderSubmitted` as separate facts.

The payment page is exercised only with supported synthetic simulator card values. Do not enter real identity or payment details. A live run is still required to verify the portal's current UI behavior.

## Architecture

```text
Scenario JSON ──> scenarioRunner (CLI client)
                         │
                         ├── asks for required sensitive values with masked input
                         ├── fetches local backend public key
                         ├── creates JWE Compact Serialization
                         │      RSA-OAEP-256 wraps a fresh AES-256 key
                         │      A256GCM encrypts the sensitive payload
                         │
                         ▼ HTTP over loopback
                  Local Express backend
                         ├── holds RSA private key in .local-keys/
                         ├── decrypts and validates JWE
                         ├── enforces the seven-minute expiry
                         ├── queues jobs through one browser worker
                         ├── persists sanitized job history in .data/
                         └── passes values in memory to Playwright
                                      │
                                      ▼
                            AllConnect demo portal
                            (normal form-field values)
```

**Important boundary:** this repository contains the local automation Express backend, not the source code for the external AllConnect portal backend. The JWE protects sensitive values from the CLI scenario client to this project's local Express backend. Playwright must decrypt/use the values in memory to populate the portal's ordinary form controls. The portal itself has not been shown to accept JWE directly. If the team lead intended the portal's own backend to be the JWE recipient, that portal must provide its public key and a JWE-aware endpoint; this repository does not contain that integration.

## Encryption design

- JWE Compact Serialization, five segments.
- Key management: `RSA-OAEP-256` (server RSA public key wraps a fresh random 256-bit AES content-encryption key for each JWE).
- Content encryption: `A256GCM` with a fresh 96-bit IV and authenticated tag.
- Protected header contains `alg`, `enc`, `kid`, and `typ`.
- The private key stays in `.local-keys/server-private.pem` on the local Express backend. It is ignored by Git and must never be shared or included in a project ZIP.
- The client retrieves only the public key from `GET /api/crypto/public-key`.
- Sensitive payloads are kept in memory and are not written to scenario JSON, reports, or a persistent sensitive-data folder.
- The encrypted payload expires exactly seven minutes after the final required input is entered. Expired input is rejected; if expiry occurs before a sensitive field is used during an interactive scenario run, the runner asks for fresh input and sends a new JWE.
- The scenario runner uses masked terminal input. For EZ-Enroll Yes, it accepts the synthetic simulator test-card values `4242424242424242` or `4111111111111111` only. Do not enter real card information.

## Install and configure

PowerShell:

```powershell
cd C:\Users\mandr\OneDrive\Desktop\allconnect-automation
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Set `PORTAL_URL` and `PORTAL_PASSWORD` in `.env`. Keep `.env` private.

Generate the backend RSA key pair once:

```powershell
npm run keys:generate
```

This creates `.local-keys/server-private.pem` and `.local-keys/server-public.pem`. The private key is the local Express backend's key; the client obtains the public key through the backend endpoint. Back up the private key securely. If it is lost, previously created JWE messages cannot be decrypted.

## Run a scenario

Interactive scenario selection:

```powershell
npm run scenario
```

Run a particular scenario:

```powershell
npm run scenario -- 4
```

The runner displays scenario choices, then prompts only for the sensitive values needed by the selected scenario:

- **EZ-Enroll No:** masked SSN and DOB for the credit-check form.
- **EZ-Enroll Yes:** masked synthetic cardholder name, supported test-card number, expiry month/year, and CVV for the payment form.

The values are encrypted as JWE before the CLI sends them to the local Express backend. The backend decrypts them in memory and Playwright fills the corresponding portal fields. If the seven-minute window expires before use, the interactive runner asks for the details again. Card values are cleared from the in-memory input object after the simulator authorization transition reaches Order Summary. For EZ-Enroll Yes, use one of the exact simulator card numbers `4242424242424242` or `4111111111111111`; other numbers are rejected before the API call.

`npm start` runs the same scenario selector.

## API endpoints

Start the persistent local API:

```powershell
npm run api
```

- `GET /health` — health status.
- `GET /api/crypto/public-key` — public RSA key and key ID; the private key is never returned.
- `POST /api/scenarios/run` — legacy synchronous authenticated scenario submission with `order` plus `sensitiveJwe`; returns 409 if the worker is occupied.
- `POST /api/orders` — legacy synchronous non-sensitive endpoint for injected/test runners; returns 409 if the worker is occupied.
- `POST /api/jobs` — authenticated asynchronous submission with `order` plus `sensitiveJwe`; returns HTTP 202 and a `jobId`. New jobs wait in a single-worker queue.
- `GET /api/jobs` — list recent sanitized job history.
- `GET /api/jobs/:jobId` — retrieve a job's state, timestamps, outcome, and safe summary.
- `POST /api/jobs/:jobId/cancel` — cancel a queued job; a running browser workflow is not interrupted or replayed.

The scenario runner starts a loopback-only Express instance for its own run, so it does not require a second terminal. For the persistent API, set a strong random `API_TOKEN` in `.env` before `npm run api`; integrations must implement the same JWE client flow. The interactive seven-minute refresh prompt is provided by `npm run scenario`; a separate API client must handle an expiry response and submit a newly encrypted JWE. Job metadata and sanitized summaries are stored in `.data/jobs.json`; sensitive scenario inputs and decrypted identity/payment values are never persisted. Pending jobs are not resumed after a process restart because their sensitive input is intentionally memory-only; any previously queued/running entries are marked interrupted in history. The queue runs one browser job at a time and accepts up to 100 waiting jobs by default.

## Scenario data

Scenario JSON files live in `test-data/scenarios/`. They must not contain `identity`, `payment`, SSN, DOB, card number, expiry, or CVV values. Those are requested only at runtime and encrypted as JWE. Non-sensitive payment preferences such as `paymentOptions.cardType` and `paymentOptions.billingAddressSameAsService` may be scenario-driven. The simulator's Submit Order transition remains locked unless an isolated demo scenario explicitly sets `execution.submitDemoOrder: true` and the local `.env` has `ALLOW_DEMO_ORDER_SUBMISSION=true`; this only reaches the simulator's Order Summary and does not submit a real order.

## Tests

Execution reports use unique run IDs, atomic file writes, private file permissions, step timing, and distinct Order Summary / Place Order / final-submission flags. Full page HTML and control dumps are not printed. Rejected encrypted-input requests write sanitized failure reports; raw validation text, SSN, DOB, card details, and credentials are not written to reports. Browser launch, action, navigation, and total-run timeouts are configurable in `.env`. Headed demo runs keep Chrome open on the final page for inspection. Set `CLOSE_BROWSER_AFTER_RUN=true` to restore automatic browser cleanup. The API handles SIGINT/SIGTERM by stopping new requests, cancelling queued jobs, and waiting for the active browser workflow to clean up before shutdown.

Run all automated tests:

```powershell
npm test
```

Run the standalone JWE round-trip and tamper test:

```powershell
npm run test:jwe
```

Run the dependency-free job queue / history smoke test:

```powershell
npm run test:jobs
```

Run the sensitive-input validation checks:

```powershell
npm run test:sensitive
```

Check syntax for an individual file:

```powershell
node --check src/main.js
```

Automated tests cover JWE round-trip and tamper detection, seven-minute expiry, backend public-key publication and JWE decryption, scenario mapping, synthetic card entry, card-type and billing selection, final authorization, Order Summary safe-stop reporting, API validation, navigation, installation selection, recovery, single-worker job execution, queued cancellation, and persistent job history. These tests do not replace a live run against the demo portal.

## Data handling

- Use synthetic demo identity and payment values only.
- Never commit `.env`, `.local-keys/`, screenshots containing customer data, or generated execution reports containing personal data.
- Do not print SSN, DOB, card number, expiry, or CVV to logs.
- The local backend decrypts values only for the duration needed by the automation and does not persist the plaintext.
- JWE expiry is checked by the backend and again before sensitive fields are used.
