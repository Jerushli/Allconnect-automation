
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

test('rejects final order submission', () => {
  const order = createOrder();
  order.execution.stopBeforeFinalOrderSubmission = false;

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Only demo orders with final submission disabled are accepted.'
  );
});

test('rejects non-demo execution mode', () => {
  const order = createOrder();
  order.execution.mode = 'production';

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Only demo orders with final submission disabled are accepted.'
  );
});

test('rejects missing order sections', () => {
  const order = createOrder();
  delete order.customer;

  expect(() => mapOrderToAutomationInput(order)).toThrow(
    'Missing or invalid order section: customer'
  );
});
