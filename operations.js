const crypto=require('node:crypto');
const fs=require('node:fs');

const state={lastMonitoringSuccess:null,lastBackupSuccess:null,lastBackupError:null};

function timeoutSignal(milliseconds=10000){return AbortSignal.timeout(milliseconds)}
function monitoringEndpoint(value){
 const url=new URL(value);
 if(url.protocol!=='https:')throw new Error('MONITORING_DSN must use HTTPS');
 if(url.username){
  const project=url.pathname.split('/').filter(Boolean).pop();
  if(!project)throw new Error('Invalid Sentry DSN');
  return{url:`${url.protocol}//${url.host}/api/${project}/store/?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`,sentry:true};
 }
 return{url:url.href,sentry:false};
}
async function reportError(error,context={}){
 if(!process.env.MONITORING_DSN)return false;
 try{
  const endpoint=monitoringEndpoint(process.env.MONITORING_DSN),event={event_id:crypto.randomBytes(16).toString('hex'),timestamp:Date.now()/1000,level:context.connectivityCheck?'info':'error',platform:'node',logger:'ledgeriq',message:String(error?.message||error).slice(0,2000),environment:process.env.NODE_ENV||'development',server_name:process.env.SERVICE_NAME||'ledgeriq',extra:context};
  const response=await fetch(endpoint.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:timeoutSignal()});
  if(!response.ok)throw new Error(`Monitoring endpoint returned ${response.status}`);
  state.lastMonitoringSuccess=new Date().toISOString();return true;
 }catch(monitoringError){console.error('Monitoring delivery failed',monitoringError.message);return false}
}
async function checkMonitoring(){return reportError(new Error('ledgerIQ monitoring connectivity check'),{connectivityCheck:true})}
function encryptBackup(buffer){
 const secret=String(process.env.BACKUP_ENCRYPTION_KEY||'');
 if(secret.length<32)throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 characters');
 const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.scryptSync(secret,salt,32),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(buffer),cipher.final()]);
 return Buffer.concat([Buffer.from('LEDGERIQ-BACKUP-V1\n'),salt,iv,cipher.getAuthTag(),encrypted]);
}
function decryptBackup(buffer){
 const header=Buffer.from('LEDGERIQ-BACKUP-V1\n');
 if(!Buffer.isBuffer(buffer)||buffer.length<header.length+44||!buffer.subarray(0,header.length).equals(header))throw new Error('Unsupported or corrupt backup');
 const secret=String(process.env.BACKUP_ENCRYPTION_KEY||'');if(secret.length<32)throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 characters');
 const salt=buffer.subarray(header.length,header.length+16),iv=buffer.subarray(header.length+16,header.length+28),tag=buffer.subarray(header.length+28,header.length+44),encrypted=buffer.subarray(header.length+44),key=crypto.scryptSync(secret,salt,32),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(encrypted),decipher.final()]);
}
async function uploadBackup(file){
 if(!process.env.OFFSITE_BACKUP_URL)return false;
 try{
  const endpoint=new URL(process.env.OFFSITE_BACKUP_URL);
  if(endpoint.protocol!=='https:')throw new Error('OFFSITE_BACKUP_URL must use HTTPS');
  endpoint.searchParams.set('filename',file.split(/[\\/]/).pop()+'.enc');
  const payload=encryptBackup(fs.readFileSync(file)),headers={'Content-Type':'application/octet-stream','Content-Length':String(payload.length)};
  if(process.env.OFFSITE_BACKUP_TOKEN)headers.Authorization=`Bearer ${process.env.OFFSITE_BACKUP_TOKEN}`;
  const response=await fetch(endpoint,{method:'PUT',headers,body:payload,signal:timeoutSignal(30000)});
  if(!response.ok)throw new Error(`Offsite backup endpoint returned ${response.status}`);
  state.lastBackupSuccess=new Date().toISOString();state.lastBackupError=null;return true;
 }catch(error){state.lastBackupError=String(error.message).slice(0,500);throw error}
}
function operationalState(){return{...state}}

module.exports={reportError,checkMonitoring,uploadBackup,operationalState,encryptBackup,decryptBackup};
