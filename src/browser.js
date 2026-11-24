'use strict';

const { chromium } = require('@playwright/test');

async function launchBrowser(headless = false, options = {}) {
  return chromium.launch({
    headless,
    timeout: Number.isInteger(options.timeout) ? options.timeout : 30000
  });
}

module.exports = { launchBrowser };
