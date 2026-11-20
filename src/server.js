
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  runAutomation: defaultRunAutomation,
  validateInput
} = require('./main');

const { mapOrderToAutomationInput } = require('./orderMapper');
const { classifyError } = require('./recovery');
const { decryptJwe } = require('./encryption');
const { ensureServerKeyPair } = require('./keyManagement');
const { validateSensitivePayload, zeroSensitivePayload } = require('./sensitiveInput');

function safeFailureCode(error) {
  if (/^(SSN_|DOB_|CVV_|EXPIRY_|TEST_CARD_|SENSITIVE_|IDENTITY_PAYLOAD_|PAYMENT_PAYLOAD_)[A-Z0-9_]*$/.test(String(error?.code || ''))) {
    return error.code;
  }
  const known = new Map([
    ['Sensitive JWE payload is invalid.', 'SENSITIVE_PAYLOAD_INVALID'],
    ['Sensitive input validity must be exactly seven minutes.', 'SENSITIVE_TTL_INVALID'],
    ['Encrypted identity payload is incomplete.', 'IDENTITY_PAYLOAD_INCOMPLETE'],
    ['Encrypted payment payload is incomplete.', 'PAYMENT_PAYLOAD_INCOMPLETE'],
    ['DOB must use MM/DD/YYYY format.', 'DOB_FORMAT_INVALID'],
    ['DOB is not a valid calendar date.', 'DOB_DATE_INVALID'],
    ['Only supported synthetic test-card numbers are accepted.', 'TEST_CARD_UNSUPPORTED'],
    ['Simulator test-card expiry must be in the future.', 'TEST_CARD_EXPIRED']
  ]);
  if (error?.code === 'SENSITIVE_INPUT_EXPIRED') return 'SENSITIVE_INPUT_EXPIRED';
  if (error?.code === 'FORM_FIELD_ACTION_FAILED') return 'FIELD_VALIDATION_FAILED';
  return known.get(String(error?.message || '')) || 'SCENARIO_VALIDATION_FAILED';
}

function saveApiFailureReport({ runId, stage, type, code }) {
  const directory = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRunId = /^[a-f0-9-]{36}$/i.test(runId || '') ? runId : crypto.randomUUID();
  const report = {
    runId: safeRunId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'failed',
    failure: { stage, type, code },
    summary: { status: 'failed', failedStep: stage, orderSummaryReached: false, finalOrderSubmitted: false },
    safetyCheckpoint: { creditCheckPerformed: false, paymentPerformed: false, installationConfirmed: false, finalOrderSubmitted: false }
  };
  const filePath = path.join(directory, `execution-report-${timestamp}-${safeRunId.slice(0, 8)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

const PORT = Number(process.env.API_PORT || 3000);

function createApp(options = {}) {
  const runAutomation =
    options.runAutomation || defaultRunAutomation;
  const isDefaultAutomationRunner = !options.runAutomation;

  const API_TOKEN =
    options.apiToken !== undefined
      ? options.apiToken
      : process.env.API_TOKEN;

  const app = express();
  const jweKeys = options.jweKeys || ensureServerKeyPair();

  let isAutomationRunning = false;

  app.use(express.json({
    limit: '32kb'
  }));

  // ----------------------------------------------------------
  // HEALTH CHECK
  // ----------------------------------------------------------

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'AllConnect Order Automation API',
      automationRunning: isAutomationRunning
    });
  });

  // Public key distribution: the public key is not secret. The matching
  // private key remains on this backend and is never returned by an endpoint.
  app.get('/api/crypto/public-key', (req, res) => {
    res.status(200).json({
      algorithm: 'RSA-OAEP-256',
      encryption: 'A256GCM',
      kid: jweKeys.kid,
      publicKey: jweKeys.publicKey
    });
  });

  // ----------------------------------------------------------
  // API AUTHENTICATION
  // ----------------------------------------------------------

  function authenticateApiToken(req, res, next) {
    if (!API_TOKEN) {
      return res.status(503).json({
        status: 'error',
        message: 'API authentication is not configured.'
      });
    }

    const authorization = req.headers.authorization || '';
    const expectedToken = `Bearer ${API_TOKEN}`;

    const receivedBuffer = Buffer.from(authorization);
    const expectedBuffer = Buffer.from(expectedToken);

    const valid =
      receivedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

    if (!valid) {
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized.'
      });
    }

    next();
  }

  // ----------------------------------------------------------
  // SUBMIT A SCENARIO WITH CLIENT-SIDE ENCRYPTED SENSITIVE INPUT
  // ----------------------------------------------------------

  app.post('/api/scenarios/run', authenticateApiToken, async (req, res) => {
    if (isAutomationRunning) {
      return res.status(409).json({ status: 'rejected', message: 'Another automation run is already in progress.' });
    }

    let automationInput;
    let decryptedSensitiveData;
    try {
      if (!req.body || typeof req.body !== 'object' || !req.body.order || typeof req.body.sensitiveJwe !== 'string') {
        throw new Error('Scenario order and encrypted sensitive payload are required.');
      }
      automationInput = mapOrderToAutomationInput(req.body.order);
      const sensitiveData = decryptJwe(req.body.sensitiveJwe, jweKeys.privateKey, jweKeys.kid);
      decryptedSensitiveData = sensitiveData;
      validateSensitivePayload(sensitiveData, req.body.order);
      automationInput.sensitiveData = sensitiveData;
      if (typeof options.requestSensitiveRefresh === 'function') {
        automationInput.requestSensitiveRefresh = async () => {
          const refreshed = await options.requestSensitiveRefresh(req.body.order);
          validateSensitivePayload(refreshed, req.body.order);
          return refreshed;
        };
      }
      validateInput(automationInput, { requireSensitiveData: true });
    } catch (error) {
      zeroSensitivePayload(decryptedSensitiveData);
      const expired = error.code === 'SENSITIVE_INPUT_EXPIRED';
      const failureType = classifyError(error).type;
      const failureCode = safeFailureCode(error);
      const runId = crypto.randomUUID();
      let reportPath = null;
      try {
        reportPath = saveApiFailureReport({
          runId,
          stage: 'input_validation',
          type: expired ? 'input_validation' : failureType,
          code: failureCode
        });
      } catch (reportError) {
        console.error('[API] Could not write sanitized validation report.');
      }
      console.error(`[API] Scenario rejected before browser start. Run ID: ${runId} Stage: input_validation Code: ${failureCode}`);
      return res.status(expired ? 428 : 400).json({
        runId,
        status: expired ? 'sensitive_input_expired' : 'invalid_scenario',
        failureType: expired ? 'input_validation' : failureType,
        failureStage: 'input_validation',
        failureCode,
        reportSaved: Boolean(reportPath),
        message: expired ? 'Sensitive input expired. Enter the required details again.' : 'Scenario validation or encrypted-input verification failed.'
      });
    }

    const runId = crypto.randomUUID();
    isAutomationRunning = true;
    try {
      const report = await runAutomation(automationInput);
      return res.status(200).json({
        runId,
        status: report.status || 'unknown',
        summary: report.summary || {},
        steps: report.steps || [],
        safetyCheckpoint: report.safetyCheckpoint || {}
      });
    } catch (error) {
      const failure = classifyError(error);
      const failureType = failure.type;
      let reportPath = null;
      try {
        // runAutomation normally writes its detailed sanitized report. This
        // fallback covers failures before its report lifecycle is initialized.
        reportPath = saveApiFailureReport({
          runId,
          stage: 'automation',
          type: failureType,
          code: 'AUTOMATION_FAILED'
        });
      } catch (reportError) {
        console.error('[API] Could not write sanitized automation failure report.');
      }
      console.error(`[API] Scenario automation failed. Run ID: ${runId} Type: ${failureType}`);
      return res.status(500).json({
        runId,
        status: 'failed',
        failureType,
        failureStage: 'automation',
        failureCode: failure.fieldFailure ? 'FIELD_VALIDATION_FAILED' : 'AUTOMATION_FAILED',
        failureStep: failure.step || null,
        fieldFailure: failure.fieldFailure || null,
        reportSaved: Boolean(reportPath),
        message: failure.fieldFailure?.message || 'Scenario automation failed. Check the local execution report.'
      });
    } finally {
      zeroSensitivePayload(decryptedSensitiveData);
      isAutomationRunning = false;
    }
  });

  // ----------------------------------------------------------
  // SUBMIT ORDER (non-sensitive API workflow)
  // ----------------------------------------------------------

  app.post(
    '/api/orders',
    authenticateApiToken,
    async (req, res) => {
      if (isDefaultAutomationRunner) {
        return res.status(400).json({
          status: 'encrypted_input_required',
          message: 'Use POST /api/scenarios/run with a JWE-encrypted sensitive payload.'
        });
      }
      if (isAutomationRunning) {
        return res.status(409).json({
          status: 'rejected',
          message: 'Another automation run is already in progress.'
        });
      }

      let automationInput;

      try {
        automationInput = mapOrderToAutomationInput(req.body);

        // Validate before browser automation starts.
        validateInput(automationInput);

      } catch (error) {
        return res.status(400).json({
          status: 'invalid_order',
          message: 'Order validation failed.'
        });
      }

      const runId = crypto.randomUUID();

      isAutomationRunning = true;

      console.log(
        `\n[API] Order automation started. Run ID: ${runId}`
      );

      try {
        const report = await runAutomation(automationInput);

        console.log(
          `[API] Order automation finished. Run ID: ${runId}`
        );

        return res.status(200).json({
          runId,
          status: report.status || 'unknown',
          summary: report.summary || {},
          steps: report.steps || [],
          safetyCheckpoint: report.safetyCheckpoint || {
            creditCheckPerformed: false,
            paymentPerformed: false,
            installationConfirmed: false,
            finalOrderSubmitted: false
          }
        });

      } catch (error) {
        const failure = classifyError(error);
        console.error(`[API] Automation failed. Run ID: ${runId} Type: ${failure.type}`);

        return res.status(500).json({
          runId,
          status: 'failed',
          failureType: failure.type,
          failureStep: failure.step || null,
          fieldFailure: failure.fieldFailure || null,
          message: failure.fieldFailure?.message || 'Automation failed. Check the local server logs and execution reports.'
        });

      } finally {
        isAutomationRunning = false;
      }
    }
  );

  // ----------------------------------------------------------
  // ERROR HANDLING
  // ----------------------------------------------------------

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({
        status: 'invalid_json',
        message: 'Request body contains invalid JSON.'
      });
    }

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        status: 'error',
        message: 'Request body exceeds the 32 KB limit.'
      });
    }

    console.error('[API] Request error:', classifyError(error).type);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.'
    });
  });

  return app;
}

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

function startServer() {
  const app = createApp();

  return app.listen(PORT, '127.0.0.1', () => {
    console.log('\n======================================');
    console.log(' ALLCONNECT AUTOMATION API');
    console.log('======================================');
    console.log(`Server running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Orders: POST http://localhost:${PORT}/api/orders`);
    console.log(`Scenario JWE: POST http://localhost:${PORT}/api/scenarios/run`);
    console.log('JWE public key: GET http://localhost:${PORT}/api/crypto/public-key');
    console.log('======================================\n');
  });
}

// Only start listening when this file is run directly.
if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
  safeFailureCode,
  saveApiFailureReport
};
