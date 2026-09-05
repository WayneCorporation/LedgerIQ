const crypto=require('node:crypto');
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex')}
function hmac(key,value,encoding){return crypto.createHmac('sha256',key).update(value).digest(encoding)}

// Sends transactional email via the AWS SES v2 API using hand-rolled SigV4 signing,
// the same approach already used for S3 in storage.js (no extra npm dependencies).
async function sendMail(to,subject,html){
 const region=process.env.SES_REGION,accessKey=process.env.SES_ACCESS_KEY,secretKey=process.env.SES_SECRET_KEY,from=process.env.MAIL_FROM;
 if(!region||!accessKey||!secretKey||!from)return false;

 const host=`email.${region}.amazonaws.com`,pathname='/v2/email/outbound-emails';
 const payload=JSON.stringify({
  FromEmailAddress:from,
  Destination:{ToAddresses:[to]},
  Content:{Simple:{Subject:{Data:subject,Charset:'UTF-8'},Body:{Html:{Data:html,Charset:'UTF-8'}}}}
 });

 const amzDate=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),date=amzDate.slice(0,8),payloadHash=sha256(payload),canonicalHeaders=`content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,signedHeaders='content-type;host;x-amz-content-sha256;x-amz-date',canonicalRequest=['POST',pathname,'',canonicalHeaders,signedHeaders,payloadHash].join('\n'),scope=`${date}/${region}/ses/aws4_request`,stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonicalRequest)].join('\n'),dateKey=hmac(`AWS4${secretKey}`,date),regionKey=hmac(dateKey,region),serviceKey=hmac(regionKey,'ses'),signingKey=hmac(serviceKey,'aws4_request'),signature=hmac(signingKey,stringToSign,'hex'),authorization=`AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

 const response=await fetch(`https://${host}${pathname}`,{
  method:'POST',
  headers:{Authorization:authorization,'Content-Type':'application/json','x-amz-date':amzDate,'x-amz-content-sha256':payloadHash},
  body:payload,
  signal:AbortSignal.timeout(10000)
 });
 return response.ok;
}

module.exports={sendMail};
