'use strict';

require('dotenv').config();

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function getConfig() {
  const portalUrl = process.env.PORTAL_URL?.trim();
  if (!portalUrl) throw new Error('PORTAL_URL missing in local .env');
  return {
    portalUrl,
    username: process.env.PORTAL_USERNAME,
    password: process.env.PORTAL_PASSWORD,
    headless: (process.env.HEADLESS || 'false').toLowerCase() === 'true',
    browserLaunchTimeoutMs: boundedInteger(process.env.BROWSER_LAUNCH_TIMEOUT_MS, 30000, 1000, 120000),
    actionTimeoutMs: boundedInteger(process.env.BROWSER_ACTION_TIMEOUT_MS, 15000, 1000, 120000),
    navigationTimeoutMs: boundedInteger(process.env.BROWSER_NAVIGATION_TIMEOUT_MS, 30000, 1000, 180000),
    maxRuntimeMs: boundedInteger(process.env.AUTOMATION_MAX_RUNTIME_MS, 900000, 30000, 3600000)
  };
}

module.exports = { getConfig, boundedInteger };
