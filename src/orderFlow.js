async function completeOrder(page,order){for(const k of ['customer','provider','speedMbps','installation'])if(order?.[k]===undefined||order[k]==='')throw new Error(`Missing order field: ${k}`);throw new Error('End-to-end workflow awaits portal inspection');}
module.exports={completeOrder};
