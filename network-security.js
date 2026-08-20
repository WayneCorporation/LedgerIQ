const dns=require('node:dns').promises;
const net=require('node:net');
const https=require('node:https');

function privateAddress(address){
 if(net.isIPv4(address)){
  const parts=address.split('.').map(Number),value=((parts[0]<<24)>>>0)+(parts[1]<<16)+(parts[2]<<8)+parts[3];
  return parts[0]===0||parts[0]===10||parts[0]===127||parts[0]>=224||(value>=0xa9fe0000&&value<=0xa9feffff)||(value>=0xac100000&&value<=0xac1fffff)||(value>=0xc0000000&&value<=0xc00000ff)||(value>=0xc0a80000&&value<=0xc0a8ffff)||(value>=0x64400000&&value<=0x647fffff)||(value>=0xc0000200&&value<=0xc00002ff)||(value>=0xc6120000&&value<=0xc613ffff)||(value>=0xc6336400&&value<=0xc63364ff)||(value>=0xcb007100&&value<=0xcb0071ff);
 }
 if(net.isIPv6(address)){
  const normalized=address.toLowerCase();
  if(normalized==='::'||normalized==='::1'||normalized.startsWith('fc')||normalized.startsWith('fd')||/^fe[89ab]/.test(normalized)||normalized.startsWith('2001:db8:'))return true;
  const mapped=normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);return mapped?privateAddress(mapped[1]):false;
 }
 return true;
}
async function assertSafeOutboundUrl(value,{allowHttp=false}={}){
 const url=value instanceof URL?new URL(value.href):new URL(value);
 if(url.protocol!=='https:'&&!(allowHttp&&url.protocol==='http:'))throw new Error('Outbound URLs must use HTTPS');
 if(url.username||url.password)throw new Error('Outbound URLs cannot contain credentials');
 const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(hostname==='localhost'||hostname.endsWith('.localhost')||hostname.endsWith('.local'))throw new Error('Private network destinations are not allowed');
 const addresses=net.isIP(hostname)?[{address:hostname}]:await dns.lookup(hostname,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(result=>privateAddress(result.address)))throw new Error('Private network destinations are not allowed');
 return url;
}
async function safeWebhookRequest(value,{headers={},body='',timeout=10000}={}){
 const url=await assertSafeOutboundUrl(value),addresses=await dns.lookup(url.hostname,{all:true,verbatim:true});if(!addresses.length||addresses.some(result=>privateAddress(result.address)))throw new Error('Private network destinations are not allowed');const destination=addresses[0];
 return new Promise((resolve,reject)=>{
  const request=https.request({protocol:'https:',hostname:destination.address,family:destination.family,port:url.port||443,path:`${url.pathname}${url.search}`,method:'POST',servername:url.hostname,headers:{Host:url.host,'Content-Length':Buffer.byteLength(body),...headers},agent:false,rejectUnauthorized:true},response=>{
   let received=0;response.on('data',chunk=>{received+=chunk.length;if(received>65536)response.destroy()});response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0}));response.on('close',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0}));
  });
  request.setTimeout(timeout,()=>request.destroy(new Error('Webhook request timed out')));request.on('error',reject);request.end(body);
 });
}

module.exports={assertSafeOutboundUrl,safeWebhookRequest,privateAddress};
