AllConnect targeted update

Files in this patch
- src/main.js
  Restores the previously working professional-installation demo submission gate:
  Scenario 5 no longer requires an additional submitDemoOrder property that its
  existing scenario JSON does not provide. The local
  ALLOW_DEMO_ORDER_SUBMISSION=true environment flag remains required. The
  professional-installation demo browser is also kept open for inspection.
- src/sensitiveInput.js
  Validates DOB using a strict UTC calendar round-trip and re-prompts when the
  entered DOB has the wrong MM/DD/YYYY format or is not a real calendar date.
- test-data/scenarios/scenario-06-encrypted-identity.json
  Canonical synthetic Scenario 6 input. It contains no identity or payment
  section; those values must be entered at runtime and sent separately as JWE.
- scripts/test-sensitive-input.js
  Small dependency-free regression test for Scenario 6 mapping and DOB input.

Install
1. Extract this ZIP into the root of your existing allconnect-automation folder.
2. Allow it to overwrite the listed files.
3. Keep your existing .env file. Do not replace it with a ZIP copy.
4. Confirm your local demo simulator setting remains:
   ALLOW_DEMO_ORDER_SUBMISSION=true
5. Run the targeted test:
   node scripts/test-sensitive-input.js
6. Run Scenario 6:
   node src/scenarioRunner.js 6

Scenario 6 sensitive-input flow
- The scenario JSON must not contain identity or payment fields.
- The runner asks for synthetic SSN and DOB in the terminal.
- DOB must be a real calendar date in MM/DD/YYYY format.
- If DOB is mistyped or impossible (for example, 02/31/1990), the prompt repeats.
- The runtime payload is encrypted as JWE and sent to /api/scenarios/run.
- The API decrypts and validates it server-side. The API rejection of plaintext
  identity/payment sections is intentional and has not been bypassed.

Scope
- Scenario 6: DOB input validation/re-prompt only; encrypted API flow preserved.
- Scenario 5: only the extra scenario-level submitDemoOrder requirement added in
  the previous patch is removed. The local demo environment opt-in remains.
- No other scenario workflow was intentionally changed.

Verification performed in the build environment
- node --check src/main.js: passed
- node --check src/sensitiveInput.js: passed
- node scripts/test-sensitive-input.js: passed
- Full Playwright suite/live portal run: not performed in this environment.
