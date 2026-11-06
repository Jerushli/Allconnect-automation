
const { test, expect } = require('@playwright/test');

const sampleOrder = require('../test-data/sample-order.json');
const { createApp } = require('../src/server');

const API_TOKEN = 'test-api-token';

let server;
let baseUrl;

let holdAutomation = false;
let releaseAutomation;
let automationStarted;

const mockReport = {
  status: 'completed',
  summary: {
    totalSteps: 21,
    completedSteps: 21,
    failedSteps: 0,
    workflowCompleted: true
  },
  steps: [],
  safetyCheckpoint: {
    creditCheckPerformed: false,
    paymentPerformed: false,
    installationConfirmed: false,
    finalOrderSubmitted: false
  }
};

async function mockRunAutomation(input) {
  if (holdAutomation) {
    automationStarted = new Promise(resolve => {
      resolveAutomationStarted = resolve;
    });

    resolveAutomationStarted();

    await new Promise(resolve => {
      releaseAutomation = resolve;
    });
  }

  return mockReport;
}

let resolveAutomationStarted;

function createOrder() {
  return JSON.parse(JSON.stringify(sampleOrder));
}

function orderRequest(order, token = API_TOKEN) {
  return fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(order)
  });
}

test.describe('AllConnect API tests', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const app = createApp({
      apiToken: API_TOKEN,
      runAutomation: mockRunAutomation
    });

    server = app.listen(0);

    await new Promise(resolve => {
      server.once('listening', resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  test('health endpoint returns HTTP 200', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.status).toBe('ok');
    expect(body.automationRunning).toBe(false);
  });

  test('rejects missing API token', async () => {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createOrder())
    });

    expect(response.status).toBe(401);
  });

  test('rejects incorrect API token', async () => {
    const response = await orderRequest(
      createOrder(),
      'incorrect-token'
    );

    expect(response.status).toBe(401);
  });

  test('rejects invalid order before automation', async () => {
    const order = createOrder();
    delete order.customer.firstName;

    const response = await orderRequest(order);

    expect(response.status).toBe(400);

    const body = await response.json();

    expect(body.status).toBe('invalid_order');
    expect(body.message).toContain('firstName');
  });

  test('accepts a valid demo order through the mock runner', async () => {
    const response = await orderRequest(createOrder());

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.status).toBe('completed');
    expect(body.summary.totalSteps).toBe(21);
    expect(body.safetyCheckpoint.finalOrderSubmitted).toBe(false);
  });

  test('rejects a second order while automation is running', async () => {
    holdAutomation = true;

    const firstRequest = orderRequest(createOrder());

    await automationStarted;

    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthBody = await healthResponse.json();

    expect(healthBody.automationRunning).toBe(true);

    const secondResponse = await orderRequest(createOrder());

    expect(secondResponse.status).toBe(409);

    const secondBody = await secondResponse.json();

    expect(secondBody.status).toBe('rejected');

    releaseAutomation();

    const firstResponse = await firstRequest;

    expect(firstResponse.status).toBe(200);

    holdAutomation = false;
  });
});
