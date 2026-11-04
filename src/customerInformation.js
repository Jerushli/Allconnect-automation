// Basic Information screen scaffold; use verified locators after DOM inspection.
async function fillCustomerInformation(page,customer){for(const k of ['firstName','lastName','zipCode','streetAddress','city','state'])if(!customer?.[k])throw new Error(`Missing customer field: ${k}`);throw new Error('Customer page locators not yet mapped');}
module.exports={fillCustomerInformation};
