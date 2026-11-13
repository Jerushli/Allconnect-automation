
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { runAutomation, validateInput } = require('./main');
const { mapOrderToAutomationInput } = require('./orderMapper');
const { classifyError } = require('./recovery');

const scenarioDirectory = path.join(
  __dirname,
  '..',
  'test-data',
  'scenarios'
);

function listScenarioFiles(directory = scenarioDirectory) {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function loadScenario(fileName, directory = scenarioDirectory) {
  // Resolve names from the scenario directory only; callers cannot supply paths.
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
    throw new Error('Scenario must be selected by its JSON file name.');
  }

  if (!listScenarioFiles(directory).includes(fileName)) {
    throw new Error(`Scenario file not found: ${fileName}`);
  }

  try {
    return JSON.parse(fs.readFileSync(path.join(directory, fileName), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Scenario ${fileName} contains invalid JSON.`);
    }
    throw error;
  }
}

function mapLocalScenarioToAutomationInput(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new Error('Scenario must be a JSON object.');
  }

  if (Object.prototype.hasOwnProperty.call(order, 'payment')) {
    throw new Error('Payment data is not accepted in local scenarios.');
  }

  let identity = null;

  if (Object.prototype.hasOwnProperty.call(order, 'identity')) {
    identity = order.identity;

    if (
      !identity ||
      typeof identity !== 'object' ||
      Array.isArray(identity)
    ) {
      throw new Error('Invalid encrypted identity section.');
    }

    const allowedFields = [
      'ssnRecordId',
      'dateOfBirthRecordId'
    ];

    if (Object.keys(identity).some(key => !allowedFields.includes(key))) {
      throw new Error(
        'Only encrypted SSN and DOB record IDs are accepted.'
      );
    }

    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (
      !uuidV4.test(identity.ssnRecordId || '') ||
      !uuidV4.test(identity.dateOfBirthRecordId || '')
    ) {
      throw new Error('Valid encrypted SSN and DOB record IDs are required.');
    }
  }

  // Keep the API mapper's existing security restrictions intact.
  const { identity: ignoredIdentity, ...safeOrder } = order;

  const automationInput = mapOrderToAutomationInput(safeOrder);

  // Pass only encrypted record references to the local automation.
  if (identity) {
    automationInput.identity = {
      ssnRecordId: identity.ssnRecordId,
      dateOfBirthRecordId: identity.dateOfBirthRecordId
    };
  }

  return automationInput;
}

async function runScenarioFile(fileName, options = {}) {
  const order = loadScenario(fileName, options.directory || scenarioDirectory);
  const automationInput = mapLocalScenarioToAutomationInput(order);
  validateInput(automationInput);

  const execute = options.runAutomation || runAutomation;
  return execute(automationInput);
}

function resolveScenarioSelection(answer, files = listScenarioFiles()) {
  if (answer === '0') return null;
  const choice = Number(answer);
  if (Number.isInteger(choice) && choice >= 1 && choice <= files.length) {
    return files[choice - 1];
  }
  if (files.includes(answer)) return answer;
  throw new Error('Invalid selection. Choose a listed number or JSON file name.');
}

async function runScenarioSelection(answer, options = {}) {
  const files = options.files || listScenarioFiles(options.directory || scenarioDirectory);
  const selectedFile = resolveScenarioSelection(answer, files);
  const log = options.log || console.log;
  if (!selectedFile) {
    log('Exited.');
    return null;
  }

  log(`Selected scenario: ${selectedFile}`);
  const order = loadScenario(selectedFile, options.directory || scenarioDirectory);
  log('Scenario loaded:', selectedFile);
  log('Customer record loaded; personal details omitted.');

  const automationInput = mapLocalScenarioToAutomationInput(order);
  validateInput(automationInput);
  log('Input validation passed.');
  log('Starting automation...');

  const execute = options.runAutomation || runAutomation;
  const report = await execute(automationInput);
  log('Scenario result:', selectedFile, report.status || 'unknown');
  return { selectedFile, report, automationInput };
}

async function main() {
  const files = listScenarioFiles();

  if (files.length === 0) {
    console.log('No scenario files found.');
    return;
  }

  console.log('\n========== ALLCONNECT SCENARIOS ==========\n');

  files.forEach((file, index) => {
    const name = file
      .replace(/scenario-\d+-/, '')
      .replace('.json', '')
      .replace(/-/g, ' ');

    console.log(`${index + 1}. ${name}`);
  });

  console.log('0. Exit');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = process.argv[2] || await new Promise(resolve => {
    rl.question('\nSelect customer scenario: ', resolve);
  });

  rl.close();

  try {
    const selection = await runScenarioSelection(answer, { files });
    if (!selection) return;
    console.log('\n========== RESULT ==========');
    console.log('Scenario:', selection.selectedFile);
    console.log('Status:', selection.report.status || 'unknown');
    console.log('Summary:', selection.report.summary || {});

  } catch (error) {
    console.error('\nScenario failed:', classifyError(error).type);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('\nScenario runner failed:', classifyError(error).type);
    process.exitCode = 1;
  });
}

module.exports = {
  listScenarioFiles,
  loadScenario,
  mapLocalScenarioToAutomationInput,
  runScenarioFile,
  resolveScenarioSelection,
  runScenarioSelection
};
