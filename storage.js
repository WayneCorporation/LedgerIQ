const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex')}
function hmac(key,value,encoding){return crypto.createHmac('sha256',key).update(value).digest(encoding)}
function encodePath(value){return String(value).split('/').map(encodeURIComponent).join('/')}
function s3Storage(){
 const endpoint=new URL(process.env.OBJECT_STORAGE_ENDPOINT),bucket=process.env.OBJECT_STORAGE_BUCKET,region=process.env.OBJECT_STORAGE_REGION||'auto',accessKey=process.env.OBJECT_STORAGE_ACCESS_KEY,secretKey=process.env.OBJECT_STORAGE_SECRET_KEY;
 if(!bucket||!accessKey||!secretKey)throw new Error('Object storage endpoint, bucket and credentials must all be configured');
 async function request(method,key,body=Buffer.alloc(0),contentType='application/octet-stream'){
  const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),date=amzDate.slice(0,8),payloadHash=sha256(body),pathname=`${endpoint.pathname.replace(/\/$/,'')}/${encodePath(bucket)}/${encodePath(key)}`.replace(/\/+/g,'/'),host=endpoint.host,canonicalHeaders=`host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,signedHeaders='host;x-amz-content-sha256;x-amz-date',canonicalRequest=[method,pathname,'',canonicalHeaders,signedHeaders,payloadHash].join('\n'),scope=`${date}/${region}/s3/aws4_request`,stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonicalRequest)].join('\n'),dateKey=hmac(`AWS4${secretKey}`,date),regionKey=hmac(dateKey,region),serviceKey=hmac(regionKey,'s3'),signingKey=hmac(serviceKey,'aws4_request'),signature=hmac(signingKey,stringToSign,'hex'),authorization=`AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response=await fetch(new URL(pathname,endpoint.origin),{method,headers:{Authorization:authorization,'x-amz-date':amzDate,'x-amz-content-sha256':payloadHash,...(method==='PUT'?{'Content-Type':contentType}:{})},body:['GET','DELETE'].includes(method)?undefined:body,redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Object storage returned ${response.status}`);return response;
 }
 return{type:'s3',put:(key,data,mime)=>request('PUT',key,data,mime),get:async key=>Buffer.from(await (await request('GET',key)).arrayBuffer()),delete:key=>request('DELETE',key)};
}
function localStorage(){const directory=process.env.OBJECT_STORAGE_PATH||(process.env.VERCEL?path.join(os.tmpdir(),'documents'):path.join(__dirname,'data','documents'));fs.mkdirSync(directory,{recursive:true});return{type:'local',put:async(key,data)=>fs.writeFileSync(path.join(directory,key),data,{flag:'wx'}),get:async key=>fs.readFileSync(path.join(directory,key)),delete:async key=>{const target=path.join(directory,key);if(fs.existsSync(target))fs.unlinkSync(target)}}}
function createStorage(){return process.env.OBJECT_STORAGE_ENDPOINT?s3Storage():localStorage()}
module.exports={createStorage};
