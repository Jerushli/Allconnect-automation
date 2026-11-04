// Screen offers New / Transfer; exact locators remain to be verified.
async function chooseQualification(page,type){if(!['New','Transfer'].includes(type))throw new Error('type must be New or Transfer');throw new Error('Qualification selectors not yet mapped');}
module.exports={chooseQualification};
