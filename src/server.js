
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
const { JobManager } = require('./jobManager');

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
  if (error?.code === 'AUTOMATION_TIMEOUT') return 'AUTOMATION_TIMEOUT';
  if (error?.code === 'FORM_FIELD_ACTION_FAILED') return 'FIELD_VALIDATION_FAILED';
  return known.get(String(error?.message || '')) || 'SCENARIO_VALIDATION_FAILED';
}

function saveApiFailureReport({ runId, stage, type, code }) {
  const directory = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRunId = /^[a-f0-9-]{36}$/i.test(runId || '') ? runId : crypto.randomUUID();
  const report = {
    runId: safeRunId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'failed',
    failure: { stage, type, code },
    durationMs: 0,
    summary: { status: 'failed', failedStep: stage, orderSummaryReached: false, placeOrderClicked: false, finalOrderSubmitted: false },
    safetyCheckpoint: { creditCheckPerformed: false, paymentPerformed: false, installationConfirmed: false, finalOrderSubmitted: false }
  };
  const filePath = path.join(directory, `execution-report-${timestamp}-${safeRunId.slice(0, 8)}.json`);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
    throw error;
  }
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

  const jobManager = options.jobManager || new JobManager({ filePath: options.jobStorePath });
  app.locals.jobManager = jobManager;

  async function executeQueuedAutomation(automationInput, jobId, cleanup) {
    automationInput.execution = { ...(automationInput.execution || {}), runId: jobId };
    try {
      return await runAutomation(automationInput);
    } catch (error) {
      const failure = classifyError(error);
      if (error?.code === 'SENSITIVE_INPUT_EXPIRED') {
        try {
          saveApiFailureReport({
            runId: jobId,
            stage: 'sensitive_input_preflight',
            type: 'input_validation',
            code: 'SENSITIVE_INPUT_EXPIRED'
          });
        } catch {
          console.error('[API] Could not write sanitized expired-input report.');
        }
      }
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        error.failureType = failure.type;
        error.failureCode = error.code === 'AUTOMATION_TIMEOUT'
          ? 'AUTOMATION_TIMEOUT'
          : error.code === 'SENSITIVE_INPUT_EXPIRED'
            ? 'SENSITIVE_INPUT_EXPIRED'
            : failure.fieldFailure ? 'FIELD_VALIDATION_FAILED' : 'AUTOMATION_FAILED';
      }
      throw error;
    } finally {
      if (typeof cleanup === 'function') cleanup();
    }
  }

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
      automationRunning: jobManager.isRunning,
      queuedJobs: jobManager.queueLength,
      activeJobId: jobManager.activeId
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
    if (jobManager.isRunning || jobManager.queueLength > 0) {
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

    const queued = jobManager.enqueue(() => executeQueuedAutomation(automationInput, queued.job.id, () => zeroSensitivePayload(decryptedSensitiveData)), { source: 'legacy_scenario_api' });
    const runId = queued.job.id;
    try {
      const completion = await queued.completion;
      if (completion.error) throw completion.error;
      const report = completion.report || {};
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
        failureCode: error.code === 'AUTOMATION_TIMEOUT' ? 'AUTOMATION_TIMEOUT' : failure.fieldFailure ? 'FIELD_VALIDATION_FAILED' : 'AUTOMATION_FAILED',
        failureStep: failure.step || null,
        fieldFailure: failure.fieldFailure || null,
        reportSaved: Boolean(reportPath),
        message: failure.fieldFailure?.message || 'Scenario automation failed. Check the local execution report.'
      });
    } finally {
      zeroSensitivePayload(decryptedSensitiveData);
    }
  });

  // ----------------------------------------------------------
  // ASYNC JOB API: queued execution and persistent job history
  // ----------------------------------------------------------

  app.post('/api/jobs', authenticateApiToken, async (req, res) => {
    let automationInput;
    let decryptedSensitiveData;
    try {
      if (!req.body || typeof req.body !== 'object' || !req.body.order || typeof req.body.sensitiveJwe !== 'string') {
        throw new Error('Scenario order and encrypted sensitive payload are required.');
      }
      automationInput = mapOrderToAutomationInput(req.body.order);
      decryptedSensitiveData = decryptJwe(req.body.sensitiveJwe, jweKeys.privateKey, jweKeys.kid);
      validateSensitivePayload(decryptedSensitiveData, req.body.order);
      automationInput.sensitiveData = decryptedSensitiveData;
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
      return res.status(expired ? 428 : 400).json({
        status: expired ? 'sensitive_input_expired' : 'invalid_scenario',
        failureStage: 'input_validation',
        failureCode: safeFailureCode(error),
        message: expired ? 'Sensitive input expired. Enter the required details again.' : 'Scenario validation or encrypted-input verification failed.'
      });
    }

    try {
      const queued = jobManager.enqueue(() => executeQueuedAutomation(automationInput, queued.job.id, () => zeroSensitivePayload(decryptedSensitiveData)), { source: 'async_scenario_api', onCancel: () => zeroSensitivePayload(decryptedSensitiveData) });
      return res.status(202).json({
        jobId: queued.job.id,
        status: queued.job.status,
        statusUrl: `/api/jobs/${queued.job.id}`,
        message: 'Automation job accepted and queued.'
      });
    } catch (error) {
      zeroSensitivePayload(decryptedSensitiveData);
      const full = error.code === 'JOB_QUEUE_FULL';
      return res.status(full ? 429 : 500).json({
        status: 'rejected',
        failureCode: full ? 'JOB_QUEUE_FULL' : 'JOB_ENQUEUE_FAILED',
        message: full ? 'Automation queue is full. Try again later.' : 'Automation job could not be queued.'
      });
    }
  });

  app.get('/api/jobs', authenticateApiToken, (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    return res.status(200).json({ jobs: jobManager.list(limit), queueLength: jobManager.queueLength, automationRunning: jobManager.isRunning });
  });

  app.get('/api/jobs/:jobId', authenticateApiToken, (req, res) => {
    const job = jobManager.get(req.params.jobId);
    if (!job) return res.status(404).json({ status: 'not_found', message: 'Job was not found.' });
    return res.status(200).json({ job });
  });

  app.post('/api/jobs/:jobId/cancel', authenticateApiToken, (req, res) => {
    const cancelled = jobManager.cancel(req.params.jobId);
    if (!cancelled) {
      const job = jobManager.get(req.params.jobId);
      if (!job) return res.status(404).json({ status: 'not_found', message: 'Job was not found.' });
      return res.status(409).json({ status: job.status, message: 'Only queued jobs can be cancelled.' });
    }
    return res.status(200).json({ job: jobManager.get(req.params.jobId) });
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
      if (jobManager.isRunning || jobManager.queueLength > 0) {
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

      const queued = jobManager.enqueue(() => executeQueuedAutomation(automationInput, queued.job.id), { source: 'legacy_order_api' });
      const runId = queued.job.id;

      console.log(
        `\n[API] Order automation started. Run ID: ${runId}`
      );

      try {
        const completion = await queued.completion;
        if (completion.error) throw completion.error;
        const report = completion.report || {};

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
          failureCode: error.code === 'AUTOMATION_TIMEOUT' ? 'AUTOMATION_TIMEOUT' : failure.fieldFailure ? 'FIELD_VALIDATION_FAILED' : 'AUTOMATION_FAILED',
          failureStep: failure.step || null,
          fieldFailure: failure.fieldFailure || null,
          message: failure.fieldFailure?.message || 'Automation failed. Check the local server logs and execution reports.'
        });

      } finally {
        // The job manager owns the single-worker lifecycle and releases the slot.
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

  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log('\n======================================');
    console.log(' ALLCONNECT AUTOMATION API');
    console.log('======================================');
    console.log(`Server running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Orders: POST http://localhost:${PORT}/api/orders`);
    console.log(`Scenario JWE: POST http://localhost:${PORT}/api/scenarios/run`);
    console.log(`Async jobs: POST/GET http://localhost:${PORT}/api/jobs`);
    console.log('JWE public key: GET http://localhost:${PORT}/api/crypto/public-key');
    console.log('======================================\n');
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[API] ${signal} received. Stopping new requests, cancelling queued jobs, and waiting for the active browser to clean up...`);
    app.locals.jobManager.cancelQueued();
    const maxRuntime = Number.parseInt(process.env.AUTOMATION_MAX_RUNTIME_MS, 10) || 900000;
    const forceTimer = setTimeout(() => {
      console.error('[API] Graceful shutdown deadline reached; closing remaining HTTP connections.');
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }, Math.min(Math.max(maxRuntime + 30000, 60000), 3660000));
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    let httpClosed = false;
    let jobsIdle = false;
    let shutdownError = null;
    const finishShutdown = () => {
      if (!httpClosed || !jobsIdle) return;
      clearTimeout(forceTimer);
      if (shutdownError) {
        console.error('[API] Server shutdown encountered an error.');
        process.exitCode = 1;
      } else {
        console.log('[API] Server and automation worker stopped cleanly.');
      }
    };
    server.close(error => {
      shutdownError = error || null;
      httpClosed = true;
      finishShutdown();
    });
    app.locals.jobManager.waitForIdle().then(() => {
      jobsIdle = true;
      finishShutdown();
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
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
