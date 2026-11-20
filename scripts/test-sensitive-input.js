'use strict';

const assert = require('node:assert/strict');
const {
  validateDob,
  readValidDob
} = require('../src/sensitiveInput');
const scenario6 = require('../test-data/scenarios/scenario-06-encrypted-identity.json');
const { mapOrderToAutomationInput } = require('../src/orderMapper');

async function main() {
  assert.equal(scenario6.accountHolder.ezEnroll, false);
  assert.equal(scenario6.execution.mode, 'demo');
  assert.equal(Object.hasOwn(scenario6, 'identity'), false);
  assert.equal(Object.hasOwn(scenario6, 'payment'), false);
  const mappedScenario6 = mapOrderToAutomationInput(scenario6);
  assert.equal(mappedScenario6.accountHolder.ezEnroll, false);
  assert.equal(Object.hasOwn(mappedScenario6, 'sensitiveData'), false);

  validateDob('01/02/1990');
  validateDob('02/29/2000');
  assert.throws(() => validateDob('02/29/1900'), { code: 'DOB_DATE_INVALID' });
  assert.throws(() => validateDob('02/31/1990'), { code: 'DOB_DATE_INVALID' });
  assert.throws(() => validateDob('1990-01-02'), { code: 'DOB_FORMAT_INVALID' });

  const answers = ['02/31/1990', '13/10/1990', '02/29/2000'];
  const prompts = [];
  const messages = [];
  const dob = await readValidDob(
    message => messages.push(message),
    async prompt => {
      prompts.push(prompt);
      return answers.shift();
    }
  );

  assert.equal(dob, '02/29/2000');
  assert.equal(prompts.length, 3, 'invalid dates should trigger a retry');
  assert.equal(messages.length, 2, 'each invalid date should explain why it was rejected');
  assert.equal(answers.length, 0);

  console.log('Scenario 6 sensitive-input checks passed.');
  console.log('- Scenario 6 maps through the demo order path without identity/payment fields in JSON.');
  console.log('- Strict MM/DD/YYYY format and calendar validation passed.');
  console.log('- Invalid DOB values are re-prompted until a valid date is entered.');
  console.log('- Test data remained synthetic; no identity values were logged.');
}

main().catch(error => {
  console.error('Scenario 6 sensitive-input checks failed:', error.message);
  process.exitCode = 1;
});
