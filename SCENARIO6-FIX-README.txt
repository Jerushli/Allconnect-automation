AllConnect automation update notes

Protected workflow
- The existing six scenario JSON files and customer / qualification / plan / checkout navigation remain unchanged.
- The demo workflow ends at a verified Order Summary.
- The simulator Submit Order UI transition requires both the scenario opt-in and ALLOW_DEMO_ORDER_SUBMISSION=true.
- This transition does not submit a real order. Reports keep Order Summary, Place Order click, payment, installation confirmation, and final order submission separate.
- The browser closes after a run by default. Set KEEP_BROWSER_OPEN=true only for local visible-browser inspection with HEADLESS=false.

Sensitive input
- Scenario JSON must not contain identity or payment fields.
- Scenario 6 asks for synthetic SSN and DOB at runtime and sends them separately as JWE.
- DOB must be a real calendar date in MM/DD/YYYY format; invalid dates are re-prompted.
- The API decrypts and validates the payload in memory. Sensitive input is not persisted in job history.

Reliability and job management
- Browser launch, action, navigation, and total-run timeouts are configurable in .env.
- Browser context and browser process are closed after each run unless local inspection is explicitly enabled.
- New asynchronous API jobs use one worker, queue waiting jobs, support queued-job cancellation, and expose job status/history.
- Sanitized job metadata is persisted in .data/jobs.json. Queued/running jobs are marked interrupted after a process restart; sensitive inputs are never persisted or resumed.
- Existing synchronous API endpoints retain their response behavior and reject a second request while the worker is occupied.

Verification commands
- npm run test:jobs
- npm run test:sensitive
- npm run test:jwe
- npm test

The dependency-free checks were run in the build environment. The complete Playwright suite requires npm dependencies and a Chromium installation; it must be run in the target environment before treating the release as fully verified.
