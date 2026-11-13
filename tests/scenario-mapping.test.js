const { test, expect } = require('@playwright/test');

const {
  listScenarioFiles,
  loadScenario,
  mapLocalScenarioToAutomationInput,
  runScenarioFile,
  resolveScenarioSelection,
  runScenarioSelection
} = require('../src/scenarioRunner');
const { validateInput } = require('../src/main');

const scenarioFiles = listScenarioFiles();

test('scenario runner lists the six checked-in scenario files in numeric order', () => {
  expect(scenarioFiles).toEqual([
    'scenario-01-new-customer.json',
    'scenario-02-transfer-customer.json',
    'scenario-03-existing-provider-customer.json',
    'scenario-04-ez-enroll.json',
    'scenario-05-professional-installation.json',
    'scenario-06-encrypted-identity.json'
  ]);
});

for (const fileName of scenarioFiles) {
  test(`${fileName} maps to valid, scenario-driven automation input`, async () => {
    const order = loadScenario(fileName);
    const input = mapLocalScenarioToAutomationInput(order);

    expect(() => validateInput(input)).not.toThrow();
    expect(input.customer.firstName).toBe(order.customer.firstName);
    expect(input.customer.lastName).toBe(order.customer.lastName);
    expect(input.qualification.customerType).toBe(order.customerType.toLowerCase());
    expect(input.plan.provider).toBe(order.provider);
    expect(input.plan.speed).toBe(`${Number.parseFloat(order.speedMbps)} Mbps`);
    expect(input.plan.term).toBe(order.plan.term);
    expect(input.plan.monthlyPrice).toBe(order.plan.monthlyPrice);
    expect(input.checkout.broadbandFactLabels).toBe(order.checkout.broadbandFactLabels);
    expect(input.checkout.equipment).toBe(order.checkout.equipment);
    expect(input.checkout.nowTv).toBe(order.checkout.nowTv);
    expect(input.installation.type).toBe(order.installation.type);

    if (order.identity) {
      expect(input.identity).toEqual(order.identity);
    }
  });

  test(`${fileName} runner executes only the selected scenario`, async () => {
    let capturedInput;
    const expected = { status: 'stubbed' };
    const result = await runScenarioFile(fileName, {
      runAutomation: async input => {
        capturedInput = input;
        return expected;
      }
    });

    expect(result).toBe(expected);
    expect(capturedInput.customer.lastName).toBe(loadScenario(fileName).customer.lastName);
  });
}

test('scenario loader rejects paths outside the scenario directory', () => {
  expect(() => loadScenario('../sample-order.json')).toThrow(
    'Scenario must be selected by its JSON file name.'
  );
});

test('scenario runner resolves numeric and named selections to the intended file', () => {
  expect(resolveScenarioSelection('4', scenarioFiles)).toBe('scenario-04-ez-enroll.json');
  expect(resolveScenarioSelection('scenario-05-professional-installation.json', scenarioFiles))
    .toBe('scenario-05-professional-installation.json');
  expect(resolveScenarioSelection('0', scenarioFiles)).toBeNull();
  expect(() => resolveScenarioSelection('7', scenarioFiles)).toThrow(/Invalid selection/);
});

test('numeric scenario selection executes the selected JSON and reports progress', async () => {
  let receivedInput;
  const progress = [];
  const result = await runScenarioSelection('4', {
    files: scenarioFiles,
    log: (...parts) => progress.push(parts.join(' ')),
    runAutomation: async input => {
      receivedInput = input;
      return { status: 'stopped_safely' };
    }
  });

  expect(result.selectedFile).toBe('scenario-04-ez-enroll.json');
  expect(receivedInput.accountHolder.ezEnroll).toBe(true);
  expect(receivedInput.installation.type).toBe('standard_shipping');
  expect(result.report.status).toBe('stopped_safely');
  expect(progress.join('\n')).toContain('Input validation passed.');
  expect(progress.join('\n')).toContain('Scenario result: scenario-04-ez-enroll.json stopped_safely');
});
