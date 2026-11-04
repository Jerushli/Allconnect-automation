require('dotenv').config();
function getConfig(){const portalUrl=process.env.PORTAL_URL?.trim();if(!portalUrl)throw new Error('PORTAL_URL missing in local .env');return {portalUrl,username:process.env.PORTAL_USERNAME,password:process.env.PORTAL_PASSWORD,headless:(process.env.HEADLESS||'false').toLowerCase()==='true'};}
module.exports={getConfig};
