const {chromium}=require('@playwright/test');
async function launchBrowser(headless=false){return chromium.launch({headless});}
module.exports={launchBrowser};
