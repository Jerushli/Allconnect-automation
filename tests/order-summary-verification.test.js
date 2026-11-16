const { test, expect } = require('@playwright/test');

const {
  collectOrderSummaryEvidence,
  hasVerifiedOrderSummary,
  clickForwardAndVerifyOrderSummary,
  sanitizeExecutionReport
} = require('../src/main');

const input = {
  customer: { firstName: 'Demo', lastName: 'Enroll' },
  plan: { provider: 'ProviderXX', monthlyPrice: 40, installationPrice: 0 },
  installation: { type: 'standard_shipping' }
};

test('execution reports omit personal data, control identifiers, values, and untrusted text', () => {
  const safe = sanitizeExecutionReport({
    customer: { firstName: 'PRIVATE_NAME_SENTINEL' },
    contact: { email: 'private@example.test', phone: '2125550123' },
    navigationInspection: {
      url: 'https://portal.test/private-token?access_token=PRIVATE_TOKEN_SENTINEL',
      forms: [{ id: 'PRIVATE_FORM_SENTINEL', name: 'PRIVATE_NAME_SENTINEL' }],
      controls: [{ tag: 'INPUT', type: 'text', id: 'PRIVATE_ID_SENTINEL', name: 'ssn', value: 'PRIVATE_SSN_SENTINEL', text: 'PRIVATE_TEXT_SENTINEL' }]
    }
  });
  const serialized = JSON.stringify(safe);
  for (const sentinel of [
    'PRIVATE_NAME_SENTINEL', 'private@example.test', '2125550123',
    'PRIVATE_TOKEN_SENTINEL', 'PRIVATE_FORM_SENTINEL', 'PRIVATE_ID_SENTINEL',
    'PRIVATE_SSN_SENTINEL', 'PRIVATE_TEXT_SENTINEL'
  ]) expect(serialized).not.toContain(sentinel);
  expect(safe.navigationInspection.forms).toEqual({ count: 1 });
  expect(safe.navigationInspection.controls[0]).not.toHaveProperty('id');
  expect(safe.navigationInspection.controls[0]).not.toHaveProperty('name');
});

test('execution report preserves only allowlisted credit-check diagnostic stages', () => {
  const stages = [
    'record_preflight',
    'ssn_fill_started',
    'ssn_fill_completed',
    'credit_button_ready',
    'dob_fill_started',
    'dob_fill_completed',
    'credit_button_click_started',
    'credit_button_click_completed',
    'credit_result_wait_started',
    'credit_result_received'
  ];
  const failure = sanitizeExecutionReport({
    error: {
      failure: {
        type: 'automation',
        step: 'Demo Credit Check, Installation and Payment',
        creditCheckStage: 'credit_button_click_started',
        message: 'PRIVATE_RAW_ERROR_SENTINEL'
      }
    }
  });

  expect(failure.error.failure.step).toBe('Demo Credit Check, Installation and Payment');
  expect(failure.error.failure.creditCheckStage).toBe('credit_button_click_started');
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_RAW_ERROR_SENTINEL');

  for (const creditCheckStage of stages) {
    const sanitized = sanitizeExecutionReport({ creditCheckStage });
    expect(sanitized.creditCheckStage).toBe(creditCheckStage);
  }

  expect(sanitizeExecutionReport({ creditCheckStage: 'PRIVATE_SSN_SENTINEL' }).creditCheckStage)
    .toBe('[redacted]');
  const rejectedFields = sanitizeExecutionReport({
    step: 'PRIVATE_CUSTOMER_STEP',
    creditCheckStage: 'PRIVATE_DOB_STAGE'
  });
  expect(rejectedFields.step).toBe('[redacted]');
  expect(rejectedFields.creditCheckStage).toBe('[redacted]');
});

const validSummaryMarkup = `
  <h1>Order Summary</h1>
  <section id="summaryForm">
    <div class="summary-row"><span>Customer Name:</span><span>Demo Enroll</span></div>
    <div class="summary-row"><span>Provider:</span><span>ProviderXX</span></div>
    <div class="summary-row"><span>Monthly Total:</span><span>$40.00</span></div>
    <div class="summary-row"><span>Installation Total:</span><span>$0.00</span></div>
    <p>CHECKOUT_COMPLETED</p>
  </section>
`;

async function getEvidence(page, markup, title = 'Order Summary') {
  await page.setContent(markup);
  await page.evaluate(value => { document.title = value; }, title);
  return collectOrderSummaryEvidence(page, input);
}

test('valid visible labeled summary fields verify the order summary', async ({ page }) => {
  const evidence = await getEvidence(page, validSummaryMarkup);
  expect(evidence.summaryHeading).toBe(true);
  expect(evidence.summaryState).toBe(true);
  expect(evidence.summaryFormPresent).toBe(true);
  expect(evidence.expectedFields).toEqual({
    customerName: true,
    provider: true,
    monthlyPrice: true,
    installationPrice: true
  });
  expect(hasVerifiedOrderSummary(evidence)).toBe(true);
});

test('hidden summary form and its values do not count as rendered summary evidence', async ({ page }) => {
  const evidence = await getEvidence(page, `
    <h1>Order Summary</h1>
    <form id="summaryForm" hidden>
      <div class="summary-row">Customer Name: Demo Enroll</div>
      <div class="summary-row">Provider: ProviderXX</div>
      <div class="summary-row">Monthly Total: $40.00</div>
      <div class="summary-row">Installation Total: $0.00</div>
    </form>
  `);
  expect(evidence.summaryFormPresent).toBe(false);
  expect(Object.values(evidence.expectedFields).every(Boolean)).toBe(false);
  expect(hasVerifiedOrderSummary(evidence)).toBe(false);
});

test('unrelated whole-page values do not satisfy labeled summary fields', async ({ page }) => {
  const evidence = await getEvidence(page, `
    <h1>Order Summary</h1>
    <p>Demo Enroll ProviderXX $40.00 $0.00</p>
    <p>Unrelated note: expected values are shown here.</p>
  `);
  expect(Object.values(evidence.expectedFields).every(Boolean)).toBe(false);
  expect(hasVerifiedOrderSummary(evidence)).toBe(false);
});

test('incomplete visible summary does not verify', async ({ page }) => {
  const evidence = await getEvidence(page, `
    <h1>Order Summary</h1>
    <section id="summaryForm">
      <div class="summary-row">Customer Name: Demo Enroll</div>
      <div class="summary-row">Provider: ProviderXX</div>
      <div class="summary-row">Monthly Total: $40.00</div>
    </section>
  `);
  expect(evidence.expectedFields).toEqual({
    customerName: true,
    provider: true,
    monthlyPrice: true,
    installationPrice: false
  });
  expect(hasVerifiedOrderSummary(evidence)).toBe(false);
});

test('heading alone does not count as Order Summary', () => {
  expect(hasVerifiedOrderSummary({
    summaryHeading: true,
    summaryState: true,
    summaryFormPresent: false,
    expectedFields: {
      customerName: false,
      provider: false,
      monthlyPrice: false,
      installationPrice: false
    }
  })).toBe(false);
});

async function prepareForwardFrame(page, summaryMarkup, delayMs = 25, emptyRoute = false) {
  await page.route('https://summary.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<iframe id="checkoutContent"></iframe>'
  }));
  await page.goto('https://summary.test/checkout/');
  const html = `
    <input id="forward" class="cbtn" type="button" value="Forward >">
    <script>
      document.getElementById('forward').addEventListener('click', () => {
        window.parent.__forwardClickCount = (window.parent.__forwardClickCount || 0) + 1;
        document.body.dataset.acPage = 'order-summary';
        try { history.pushState({}, '', '/allconnect-frame/order-summary/'); } catch { /* srcdoc origin */ }
        setTimeout(() => {
          ${emptyRoute ? '' : "document.title = 'Order Summary'; document.body.innerHTML = " + JSON.stringify(summaryMarkup) + ';'}
        }, ${delayMs});
      });
    </script>
  `;
  await page.locator('#checkoutContent').evaluate((frame, content) => { frame.srcdoc = content; }, html);
  const frame = page.frameLocator('#checkoutContent');
  const button = frame.locator('input.cbtn[value="Forward >"]');
  await button.waitFor({ state: 'visible' });
  return { frame, button };
}

test('single Forward click waits for delayed visible labeled summary fields', async ({ page }) => {
  const { frame, button } = await prepareForwardFrame(page, validSummaryMarkup, 350);
  const result = await clickForwardAndVerifyOrderSummary(page, frame, input, button, {
    controls: [{ text: 'Forward >', type: 'button', insideForm: false, formActionPresent: false }],
    transitionTimeoutMs: 1000,
    renderTimeoutMs: 2000,
    domContentLoadedTimeoutMs: 100,
    networkIdleTimeoutMs: 100
  });
  expect(result.reached).toBe(true);
  expect(Object.values(result.summaryEvidence.expectedFields).every(Boolean)).toBe(true);
  expect(await page.evaluate(() => window.__forwardClickCount)).toBe(1);
});

test('empty summary route times out with diagnostics and is not counted as reached', async ({ page }) => {
  const { frame, button } = await prepareForwardFrame(page, '', 0, true);
  const result = await clickForwardAndVerifyOrderSummary(page, frame, input, button, {
    controls: [{ text: 'Forward >', type: 'button', insideForm: false, formActionPresent: false }],
    renderTimeoutMs: 250,
    transitionTimeoutMs: 1000,
    domContentLoadedTimeoutMs: 100,
    networkIdleTimeoutMs: 100
  });
  expect(result.reached).toBe(false);
  expect(result.summaryEvidence.renderWait.status).toBe('timed_out_empty_summary');
  expect(result.summaryEvidence.renderWait.summaryRouteDetected).toBe(true);
  expect(await page.evaluate(() => window.__forwardClickCount)).toBe(1);
});
test('summary state without a visible summary form is rejected', () => {
  expect(hasVerifiedOrderSummary({
    summaryHeading: true,
    summaryState: true,
    summaryFormPresent: false,
    expectedFields: {
      customerName: true,
      provider: true,
      monthlyPrice: true,
      installationPrice: true
    }
  })).toBe(false);
});

test('summary without a heading is rejected even when all fields match', () => {
  expect(hasVerifiedOrderSummary({
    summaryHeading: false,
    summaryState: true,
    summaryFormPresent: true,
    expectedFields: {
      customerName: true,
      provider: true,
      monthlyPrice: true,
      installationPrice: true
    }
  })).toBe(false);
});

test('summary with any missing expected field is rejected', () => {
  expect(hasVerifiedOrderSummary({
    summaryHeading: true,
    summaryFormPresent: true,
    expectedFields: {
      customerName: true,
      provider: true,
      monthlyPrice: false,
      installationPrice: true
    }
  })).toBe(false);
});
test('Order Summary report preserves verification booleans but redacts customer data', () => {
  const safe = sanitizeExecutionReport({
    orderSummaryVerification: {
      summaryHeading: true,
      summaryFormPresent: true,
      summaryState: true,
      expectedFields: {
        customerName: true,
        provider: true,
        monthlyPrice: true,
        installationPrice: true
      },
      customerName: 'PRIVATE_CUSTOMER_SENTINEL',
      bodyText: 'PRIVATE_BODY_SENTINEL',
      url: 'https://portal.test/allconnect-frame/order-summary/?token=PRIVATE_TOKEN'
    }
  });

  const serialized = JSON.stringify(safe);

  expect(safe.orderSummaryVerification.summaryHeading).toBe(true);
  expect(safe.orderSummaryVerification.summaryFormPresent).toBe(true);
  expect(safe.orderSummaryVerification.expectedFields.customerName).toBe(true);
  expect(safe.orderSummaryVerification.expectedFields.monthlyPrice).toBe(true);

  expect(serialized).not.toContain('PRIVATE_CUSTOMER_SENTINEL');
  expect(serialized).not.toContain('PRIVATE_BODY_SENTINEL');
  expect(serialized).not.toContain('PRIVATE_TOKEN');
});
test('route response sanitizer preserves only the exact Order Summary route', () => {
  const safe = sanitizeExecutionReport({
    routeResponses: [
      {
        path: '/allconnect-frame/order-summary',
        status: 200
      },
      {
        path: '/private/customer-details',
        status: 302
      },
      {
        path: '/allconnect-frame/order-summary?token=PRIVATE_TOKEN',
        status: 200
      }
    ]
  });

  expect(safe.routeResponses[0]).toEqual({
    path: '/allconnect-frame/order-summary',
    status: 200
  });

  expect(safe.routeResponses[1]).toEqual({
    path: '[redacted]',
    status: 302
  });

  expect(safe.routeResponses[2].path).toBe('[redacted]');

  expect(JSON.stringify(safe)).not.toContain('PRIVATE_TOKEN');
});
test('sanitizer preserves safe form inspection metadata', () => {
  const safe = sanitizeExecutionReport({
    navigationInspection: {
      controls: [
        {
          tag: 'BUTTON',
          type: 'button',
          text: 'Confirm Installation >',
          formDetails: {
            present: true,
            idPresent: true,
            actionPresent: true,
            action: 'https://portal.test/allconnect-frame/installation-payment/',
            method: 'POST',
            enctype: 'application/x-www-form-urlencoded',
            target: '_self',
            inlineOnsubmitPresent: true,
            submitControlCount: 1
          }
        }
      ]
    }
  });

  const details =
    safe.navigationInspection.controls[0].formDetails;

  expect(details.present).toBe(true);
  expect(details.actionPresent).toBe(true);
  expect(details.method).toBe('POST');
  expect(details.target).toBe('_self');
  expect(details.inlineOnsubmitPresent).toBe(true);
  expect(details.submitControlCount).toBe(1);
});

test('sanitizer preserves safe button submission metadata', () => {
  const safe = sanitizeExecutionReport({
    navigationInspection: {
      controls: [{
        tag: 'BUTTON',
        type: 'submit',
        text: 'Confirm Installation >',
        formMethod: 'POST',
        formNoValidate: true,
        inlineOnclickPresent: true
      }]
    }
  });

  const control = safe.navigationInspection.controls[0];

  expect(control.type).toBe('submit');
  expect(control.formMethod).toBe('POST');
  expect(control.formNoValidate).toBe(true);
  expect(control.inlineOnclickPresent).toBe(true);
});