
const { test, expect } = require('@playwright/test');
const sampleOrder = require('../test-data/sample-order.json');

const { mapOrderToAutomationInput } = require('../src/orderMapper');
const { validateInput } = require('../src/main');

function createOrder() {
  return JSON.parse(JSON.stringify(sampleOrder));
}

test('valid demo order passes mapping and validation', () => {
  const input = mapOrderToAutomationInput(createOrder());

  expect(input.execution.mode).toBe('demo');
  expect(input.execution.stopBeforeFinalOrderSubmission).toBe(true);
  expect(input.installation.confirmInstallation).toBe(false);

  expect(() => validateInput(input)).not.toThrow();
});

test('rejects orders missing customer details', () => {
  const order = createOrder();
  delete order.customer.firstName;

  const input = mapOrderToAutomationInput(order);

  expect(() => validateInput(input)).toThrow(
    'Missing required customer field: firstName'
  );
});

test('rejects payment information', () => {
  const order = createOrder();
  order.payment = { method: 'card' };

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Identity and payment sections are not accepted by this API.'
  );
});

test('rejects identity information', () => {
  const order = createOrder();
  order.identity = { ssn: '123456789' };

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Identity and payment sections are not accepted by this API.'
  );
});

test('rejects installation confirmation', () => {
  const order = createOrder();
  order.installation.confirmInstallation = true;

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Installation confirmation cannot be enabled through this API.'
  );
});

test('requires explicit opt-in for the simulator Order Summary transition', () => {
  const order = createOrder();
  order.execution.stopBeforeFinalOrderSubmission = false;

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Only demo orders are accepted; the simulator Order Summary transition requires explicit demo opt-in.'
  );
});


test('simulator Order Summary transition requires a separate local environment opt-in', () => {
  const scenario = JSON.parse(JSON.stringify(require('../test-data/scenarios/scenario-04-ez-enroll.json')));
  const input = mapOrderToAutomationInput(scenario);
  const previous = process.env.ALLOW_DEMO_ORDER_SUBMISSION;
  delete process.env.ALLOW_DEMO_ORDER_SUBMISSION;
  try {
    expect(() => validateInput(input)).toThrow(
      'Simulator Order Summary transition is locked. Set ALLOW_DEMO_ORDER_SUBMISSION=true locally only for the isolated demo portal.'
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEMO_ORDER_SUBMISSION;
    else process.env.ALLOW_DEMO_ORDER_SUBMISSION = previous;
  }
});

test('rejects non-demo execution mode', () => {
  const order = createOrder();
  order.execution.mode = 'production';

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Only demo orders are accepted; the simulator Order Summary transition requires explicit demo opt-in.'
  );
});

test('rejects missing order sections', () => {
  const order = createOrder();
  delete order.customer;

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Missing or invalid order section: customer'
  );
});

