
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const {
  runAutomation: defaultRunAutomation,
  validateInput
} = require('./main');

const { mapOrderToAutomationInput } = require('./orderMapper');

const PORT = Number(process.env.API_PORT || 3000);

function createApp(options = {}) {
  const runAutomation =
    options.runAutomation || defaultRunAutomation;

  const API_TOKEN =
    options.apiToken !== undefined
      ? options.apiToken
      : process.env.API_TOKEN;

  const app = express();

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
  // SUBMIT ORDER
  // ----------------------------------------------------------

  app.post(
    '/api/orders',
    authenticateApiToken,
    async (req, res) => {
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
          message: error.message
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
          status: report.status || 'completed',
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
        console.error(
          `[API] Automation failed. Run ID: ${runId}`,
          error.message
        );

        return res.status(500).json({
          runId,
          status: 'failed',
          message: 'Automation failed. Check the local server logs and execution reports.'
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

    console.error('[API] Request error:', error.message);

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

  return app.listen(PORT, () => {
    console.log('\n======================================');
    console.log(' ALLCONNECT AUTOMATION API');
    console.log('======================================');
    console.log(`Server running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Orders: POST http://localhost:${PORT}/api/orders`);
    console.log('Final order submission remains disabled.');
    console.log('======================================\n');
  });
}

// Only start listening when this file is run directly.
if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
