# AllConnect Internet Order Automation

Node.js and Playwright automation for the AllConnect simulated internet-order portal. Scenario JSON controls the customer, qualification, provider, plan, checkout customizations, account-holder answers, and installation choice. SSN, DOB, and simulator test-card details are collected interactively at run time and are never stored in scenario JSON.

## Current completion boundary

The automation supports the simulator workflow through the final confirmation page. Final submission is disabled by default. Only the dedicated EZ-Enroll demo scenario opts in through `execution.submitDemoOrder: true`, and a second local guard (`ALLOW_DEMO_ORDER_SUBMISSION=true` in `.env`) must also be enabled. The runner then requires the final authorization Read checkbox, clicks the visible Submit Order control, and verifies a confirmation message before setting `finalOrderSubmitted: true`. Keep the environment flag false except when `PORTAL_URL` is confirmed to be the isolated demo portal; use synthetic test-card values only.

The portal's EZ-Enroll and payment DOM has been implemented against the supplied inspection evidence: the Card Type dropdown, card fields, billing-address Yes/No radios, payment Forward control, subsequent Read checkbox, and Submit Order control. A live run is still required to verify the simulator's actual confirmation response.

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

The values are encrypted as JWE before the CLI sends them to the local Express backend. The backend decrypts them in memory and Playwright fills the corresponding portal fields. If the seven-minute window expires before use, the interactive runner asks for the details again. Card values are cleared from the in-memory input object after the payment fields are populated. For EZ-Enroll Yes, use one of the exact simulator card numbers `4242424242424242` or `4111111111111111`; other numbers are rejected before the API call.

`npm start` runs the same scenario selector.

## API endpoints

Start the persistent local API:

```powershell
npm run api
```

- `GET /health` — health status.
- `GET /api/crypto/public-key` — public RSA key and key ID; the private key is never returned.
- `POST /api/scenarios/run` — authenticated scenario submission with `order` plus `sensitiveJwe`.
- `POST /api/orders` — legacy non-sensitive endpoint; the interactive scenario flow should use `/api/scenarios/run`.

The scenario runner starts a loopback-only Express instance for its own run, so it does not require a second terminal. For the persistent API, set a strong random `API_TOKEN` in `.env` before `npm run api`; integrations must implement the same JWE client flow. The interactive seven-minute refresh prompt is provided by `npm run scenario`; a separate API client must handle an expiry response and submit a newly encrypted JWE.

## Scenario data

Scenario JSON files live in `test-data/scenarios/`. They must not contain `identity`, `payment`, SSN, DOB, card number, expiry, or CVV values. Those are requested only at runtime and encrypted as JWE. Non-sensitive payment preferences such as `paymentOptions.cardType` and `paymentOptions.billingAddressSameAsService` may be scenario-driven. Final submission remains disabled unless an isolated demo scenario explicitly sets `execution.submitDemoOrder: true` and the local `.env` has `ALLOW_DEMO_ORDER_SUBMISSION=true`.

## Tests

Every rejected encrypted-input request now writes a sanitized failure report to `reports/` and returns a non-sensitive failure stage/code. Browser automation failures retain the detailed sanitized report produced by the runner; the API writes a fallback report if the runner fails before it can create one. Raw validation text, SSN, DOB, card details, and credentials are not written to these reports.

Run all automated tests:

```powershell
npm test
```

Run the standalone JWE round-trip and tamper test:

```powershell
npm run test:jwe
```

Check syntax for an individual file:

```powershell
node --check src/main.js
```

Automated tests cover JWE round-trip and tamper detection, seven-minute expiry, backend public-key publication and JWE decryption, scenario mapping, credit-check input, synthetic card entry, card-type and billing selection, final authorization, demo submission and confirmation verification, API validation, navigation, installation selection, and recovery. These tests do not replace a live run against the demo portal.

## Data handling

- Use synthetic demo identity and payment values only.
- Never commit `.env`, `.local-keys/`, screenshots containing customer data, or generated execution reports containing personal data.
- Do not print SSN, DOB, card number, expiry, or CVV to logs.
- The local backend decrypts values only for the duration needed by the automation and does not persist the plaintext.
- JWE expiry is checked by the backend and again before sensitive fields are used.
