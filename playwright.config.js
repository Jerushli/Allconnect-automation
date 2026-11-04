const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({testDir:'./tests',reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],use:{browserName:'chromium',headless:true,trace:'retain-on-failure',screenshot:'only-on-failure'}});
