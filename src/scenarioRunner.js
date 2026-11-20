
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { runAutomation, validateInput } = require('./main');
const { mapOrderToAutomationInput } = require('./orderMapper');
const { classifyError } = require('./recovery');
const { createApp } = require('./server');
const { ensureServerKeyPair } = require('./keyManagement');
const { encryptJwe, decryptJwe } = require('./encryption');
const { promptSensitivePayload, validateSensitivePayload, zeroSensitivePayload } = require('./sensitiveInput');
const crypto = require('crypto');

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
  if (Object.prototype.hasOwnProperty.call(order, 'identity') || Object.prototype.hasOwnProperty.call(order, 'payment')) {
    throw new Error('Sensitive identity and payment values must be entered at runtime, not stored in scenario JSON.');
  }
  return mapOrderToAutomationInput(order);
}

async function postEncryptedScenario(order, options = {}) {
  const keys = options.jweKeys || ensureServerKeyPair();
  const apiToken = crypto.randomBytes(32).toString('hex');
  const app = createApp({
    apiToken,
    jweKeys: keys,
    runAutomation: options.runAutomation || runAutomation,
    requestSensitiveRefresh: async scenarioOrder => {
      const refreshed = await promptSensitivePayload(scenarioOrder, options.log || console.log);
      validateSensitivePayload(refreshed, scenarioOrder);
      const refreshedJwe = encryptJwe(refreshed, keys.publicKey, keys.kid);
      const serverSidePayload = decryptJwe(refreshedJwe, keys.privateKey, keys.kid);
      validateSensitivePayload(serverSidePayload, scenarioOrder);
      return serverSidePayload;
    }
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  let sensitivePayload;

  try {
    const keyResponse = await fetch(`${baseUrl}/api/crypto/public-key`);
    if (!keyResponse.ok) throw new Error('Could not retrieve the automation backend public key.');
    const keyInfo = await keyResponse.json();
    if (keyInfo.kid !== keys.kid || keyInfo.algorithm !== 'RSA-OAEP-256' || keyInfo.encryption !== 'A256GCM') {
      throw new Error('Automation backend returned an unsupported or mismatched JWE key.');
    }

    let response;
    let resultBody;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      sensitivePayload = await promptSensitivePayload(order, options.log || console.log);
      validateSensitivePayload(sensitivePayload, order);
      const sensitiveJwe = encryptJwe(sensitivePayload, keyInfo.publicKey, keyInfo.kid);
      response = await fetch(`${baseUrl}/api/scenarios/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order, sensitiveJwe })
      });
      resultBody = await response.json();
      zeroSensitivePayload(sensitivePayload);
      sensitivePayload = null;
      if (response.status !== 428) break;
      (options.log || console.log)('Sensitive input expired before the backend accepted it. Please enter it again.');
    }

    if (!response || !response.ok) {
      const failureType = resultBody?.failureType || 'api';
      const failureStage = resultBody?.failureStage || 'encrypted_api_request';
      const failureCode = resultBody?.failureCode || 'ENCRYPTED_SCENARIO_REQUEST_FAILED';
      const error = new Error(`Scenario request failed: ${failureType} at ${failureStage} (${failureCode}).`);
      error.failureType = failureType;
      error.failureStage = failureStage;
      error.failureCode = failureCode;
      error.runId = resultBody?.runId || null;
      throw error;
    }
    return resultBody;
  } finally {
    if (sensitivePayload) zeroSensitivePayload(sensitivePayload);
    await new Promise(resolve => server.close(resolve));
  }
}

async function runScenarioFile(fileName, options = {}) {
  const order = loadScenario(fileName, options.directory || scenarioDirectory);
  const automationInput = mapLocalScenarioToAutomationInput(order);
  validateInput(automationInput);

  if (options.runAutomation) return options.runAutomation(automationInput);
  return postEncryptedScenario(order, options);
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

  let report;
  if (options.runAutomation) {
    // Test hook: keep deterministic unit tests independent of terminal input.
    log('Starting automation...');
    report = await options.runAutomation(automationInput);
  } else {
    log('Sensitive values will be requested now and encrypted before they reach the local backend.');
    report = await postEncryptedScenario(order, { log });
  }

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
    const failureType = error.failureType || classifyError(error).type;
    const failureStage = error.failureStage || (failureType === 'input_validation' ? 'sensitive_input' : null);
    const failureCode = error.failureCode || (/^[A-Z0-9_]{3,64}$/.test(String(error.code || '')) ? error.code : null);
    console.error('\nScenario failed:', failureType);
    if (failureStage) console.error('Failure stage:', failureStage);
    if (failureCode) console.error('Failure code:', failureCode);
    if (error.runId) console.error('Run ID:', error.runId);
    if (error.failureStage === 'input_validation') console.error('A sanitized failure report was saved in the reports folder.');
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
  runScenarioSelection,
  postEncryptedScenario,
  main
};
