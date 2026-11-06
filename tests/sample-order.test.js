
const { test, expect } = require('@playwright/test');
const order = require('../test-data/sample-order.json');

test('sample order has required fields and valid installation settings', () => {
  // Customer details
  expect(order.customer.firstName).toBeTruthy();
  expect(order.customer.lastName).toBeTruthy();

  // Customer qualification
  expect(['New', 'Transfer']).toContain(order.customerType);

  // Provider and plan
  expect(order.provider).toBeTruthy();
  expect(order.speedMbps).toBeGreaterThan(0);
  expect(order.plan.term).toBeTruthy();
  expect(order.plan.monthlyPrice).toBeGreaterThan(0);

  // Checkout configuration
  expect(['requested', 'not_requested']).toContain(
    order.checkout.broadbandFactLabels
  );
  expect(typeof order.checkout.broadbandFactLabelsRead).toBe('boolean');
  expect(['leased_gateway', 'own_equipment']).toContain(
    order.checkout.equipment
  );
  expect(typeof order.checkout.nowTv).toBe('boolean');

  // Installation configuration
  expect(order.installation).toBeDefined();
  expect(['standard_shipping', 'professional_installation']).toContain(
    order.installation.type
  );

  // Final order submission must remain disabled.
  expect(order.execution.stopBeforeFinalOrderSubmission).toBe(true);

  // No SSN should be stored in the sample order.
  expect(order).not.toHaveProperty('ssn');
  expect(order.identity?.ssn || '').toBe('');
});
