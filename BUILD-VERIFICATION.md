# AllConnect stages 1-4 build verification

## Baseline supplied with the project

The test output supplied for this audit reported 88 Playwright tests: 86 passed and 2 failed. Both failures were in `tests/payment-flow.test.js`:

- EZ-Enroll Yes payment flow: `Place Order button was not found` at `src/main.js` in `clickPlaceOrderAndVerify`.
- Expired EZ-Enroll payload refresh flow: the same missing-button failure.

The fixture reached a visible `Order Summary` with `CHECKOUT_COMPLETED` but did not render a separate `Place Order` button. The latest correction keeps that case as a safe stop, while also detecting and clicking a separate visible `Place Order` control when a scenario and the local demo environment explicitly opt in. A dispatched click is reported separately; it is not treated as verified final submission or confirmation.

## Implemented stages

1. **Execution reporting:** unique UUID run IDs, atomic report writes, private file permissions, duration and step counts, explicit Order Summary / Place Order / final submission flags, and removal of full Order Summary HTML/control dumps from logs.
2. **Reliability:** configurable launch/action/navigation/overall timeouts, watchdog browser closure, page default timeouts, browser/context cleanup after runs, and graceful SIGINT/SIGTERM shutdown that cancels queued work and waits for the active worker.
3. **Job management:** single-worker queue, 100 waiting-job limit, `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:jobId`, queued-job cancellation, and legacy synchronous endpoint compatibility.
4. **Persistent history:** sanitized metadata and safe summary/safety flags stored atomically in `.data/jobs.json`; sensitive inputs are never persisted. Queued/running jobs are marked interrupted after restart and are not replayed.

## Verification performed in this build environment

Passed:

- `node --check` for all JavaScript files in `src/`, `tests/`, and `scripts/`.
- Parse and mapping check for all six scenario JSON files.
- `npm run test:jobs` — single-worker ordering, persistent history/reload, interrupted-job recovery, cancellation, and sensitive-input cleanup.
- `npm run test:sensitive` — Scenario 6 mapping and strict DOB validation.
- `npm run test:jwe` — RSA-OAEP-256 / A256GCM round-trip and tamper detection.
- Automation watchdog timeout classification check.

Not run / blocked:

- Full `npm test` Playwright suite and browser-backed payment/API tests.
- The uploaded ZIP did not contain `node_modules`. `npm ci` timed out in this build environment. As a result, the Node `@playwright/test` package is unavailable here; `npm test` resolves to an unrelated Python Playwright command and reports `unknown command 'test'`.
- No live portal workflow was run. The six existing scenarios were parsed and mapped only; their JSON files were not changed.

## Required target-environment verification

From the extracted project root on the user's Windows machine:

```powershell
npm install
npx playwright install chromium
npm test
```

If any Playwright tests fail, retain the output and fix those failures before treating this build as fully verified. Keep the existing `.env` and `.local-keys/` files private; neither is included in this ZIP.


## Latest targeted correction: final Place Order and browser retention

- After the existing Submit Order step and verified Order Summary, the automation now checks all page frames for one visible, enabled control labelled exactly `Place Order`.
- The final click is allowed only when the scenario has `execution.submitDemoOrder: true`, `execution.mode: "demo"`, and the local `.env` has `ALLOW_DEMO_ORDER_SUBMISSION=true`.
- The control is given up to five seconds to appear. If it is absent, the existing Order Summary safe-stop behavior is preserved. Ambiguous multiple matches fail safely rather than clicking an arbitrary control.
- `placeOrderClicked` reflects whether the click was dispatched. `finalOrderSubmitted` and order-confirmation flags remain false unless separately verified; this patch does not invent confirmation evidence.
- Headed demo runs now keep Chrome open on the final page by default. Set `CLOSE_BROWSER_AFTER_RUN=true` to restore automatic cleanup. Headless runs still close normally, and the watchdog still closes a timed-out run.
- The six scenario JSON files and all preceding workflow steps were left unchanged. One focused Playwright test was added for the separately rendered Place Order control.

## Verification for this latest patch

Passed in this environment:

- `node --check` for every JavaScript file in `src/`, `tests/`, and `scripts/`.
- JSON parse check for all six scenario files.

Not run:

- `npm test`: the uploaded ZIP has no `node_modules`; dependency installation timed out in this environment. The local `npm test` attempt therefore resolved to an unrelated system Playwright command and returned `unknown command 'test'`.
- No live portal run was performed. The added Place Order test must be run with the project's installed npm dependencies before treating the patch as fully verified.
