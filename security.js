const crypto=require('node:crypto');

const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer){let bits='',out='';for(const byte of buffer)bits+=byte.toString(2).padStart(8,'0');for(let i=0;i<bits.length;i+=5)out+=B32[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];return out}
function base32Decode(value){let bits='';for(const char of String(value).replace(/=+$/,'').toUpperCase()){const index=B32.indexOf(char);if(index>=0)bits+=index.toString(2).padStart(5,'0')}const bytes=[];for(let i=0;i+8<=bits.length;i+=8)bytes.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(bytes)}
function totp(secret,time=Date.now()){const counter=Math.floor(time/30000),message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));const digest=crypto.createHmac('sha1',base32Decode(secret)).update(message).digest(),offset=digest[digest.length-1]&15,number=(digest.readUInt32BE(offset)&0x7fffffff)%1_000_000;return String(number).padStart(6,'0')}
function verifyTotp(secret,code){const supplied=String(code||'').replace(/\s/g,'');if(!/^\d{6}$/.test(supplied))return false;return[-1,0,1].some(window=>{const expected=totp(secret,Date.now()+window*30000);return crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))})}

function initSecurity(db,h){
 const {send,fail,body,clean,now,id,email,hash,passwordHash,passwordMatches}=h;
 const columns=db.prepare('PRAGMA table_info(users)').all().map(row=>row.name);
 if(!columns.includes('email_verified_at'))db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
 if(!columns.includes('totp_secret'))db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''");
 if(!columns.includes('mfa_enabled'))db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
 db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,type TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_auth_tokens_lookup ON auth_tokens(token_hash,type,expires_at);`);

 async function sendMail(to,subject,html){if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return false;const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:[to],subject,html}),signal:AbortSignal.timeout(10000)});return response.ok}
 async function issue(userId,type){db.prepare('UPDATE auth_tokens SET used_at=? WHERE user_id=? AND type=? AND used_at IS NULL').run(now(),userId,type);const raw=crypto.randomBytes(32).toString('base64url');db.prepare('INSERT INTO auth_tokens VALUES(?,?,?,?,?,?,?)').run(id(),userId,type,hash(raw),new Date(Date.now()+(type==='verify_email'?24*60:30)*60000).toISOString(),null,now());return raw}
 async function sendVerification(userId,userEmail){const raw=await issue(userId,'verify_email'),origin=process.env.APP_ORIGIN||'http://localhost:3000',sent=await sendMail(userEmail,'Verify your ledgerIQ email',`<p>Verify your email to secure your ledgerIQ account.</p><p><a href="${origin}/app?verify=${encodeURIComponent(raw)}">Verify email</a></p>`);return{sent,...(!sent&&process.env.NODE_ENV!=='production'?{token:raw}:{})}}
 async function handlePublic(req,res,url){
  if(req.method==='POST'&&url.pathname==='/api/auth/password/request'){const d=await body(req),user=db.prepare('SELECT id,email FROM users WHERE email=?').get(email(d.email));if(user){const raw=await issue(user.id,'password_reset'),origin=process.env.APP_ORIGIN||'http://localhost:3000';await sendMail(user.email,'Reset your ledgerIQ password',`<p><a href="${origin}/app?reset=${encodeURIComponent(raw)}">Reset your password</a>. This link expires in 30 minutes.</p>`);if(process.env.NODE_ENV!=='production'){send(res,200,{ok:true,resetToken:raw});return true}}send(res,200,{ok:true});return true}
  if(req.method==='POST'&&url.pathname==='/api/auth/password/reset'){const d=await body(req),password=String(d.password||''),row=db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? AND type='password_reset' AND used_at IS NULL AND expires_at>?`).get(hash(clean(d.token,200)),now());if(!row||password.length<10){fail(res,400,'Reset link is invalid or the new password is too short');return true}db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash(password),row.user_id);db.prepare('UPDATE auth_tokens SET used_at=? WHERE id=?').run(now(),row.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);send(res,200,{ok:true});return true}
  if(req.method==='POST'&&url.pathname==='/api/auth/verify-email'){const d=await body(req),row=db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? AND type='verify_email' AND used_at IS NULL AND expires_at>?`).get(hash(clean(d.token,200)),now());if(!row){fail(res,400,'Verification link is invalid or expired');return true}db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(now(),row.user_id);db.prepare('UPDATE auth_tokens SET used_at=? WHERE id=?').run(now(),row.id);send(res,200,{ok:true});return true}
  return false;
 }
 function checkLogin(user,code){if(!user.mfa_enabled)return true;return verifyTotp(user.totp_secret,code)}
 async function handleProtected(req,res,url,user){
  if(req.method==='GET'&&url.pathname==='/api/security/status'){const row=db.prepare('SELECT email_verified_at emailVerifiedAt,mfa_enabled mfaEnabled FROM users WHERE id=?').get(user.user_id);send(res,200,row);return true}
  if(req.method==='POST'&&url.pathname==='/api/security/verify/resend'){const result=await sendVerification(user.user_id,user.email);send(res,200,{ok:true,...result});return true}
  if(req.method==='POST'&&url.pathname==='/api/security/mfa/setup'){const secret=base32Encode(crypto.randomBytes(20)),label=encodeURIComponent(`ledgerIQ:${user.email}`),issuer=encodeURIComponent('ledgerIQ');db.prepare('UPDATE users SET totp_secret=?,mfa_enabled=0 WHERE id=?').run(secret,user.user_id);send(res,200,{secret,otpauth:`otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`});return true}
  if(req.method==='POST'&&url.pathname==='/api/security/mfa/enable'){const d=await body(req),row=db.prepare('SELECT totp_secret FROM users WHERE id=?').get(user.user_id);if(!row?.totp_secret||!verifyTotp(row.totp_secret,d.code)){fail(res,400,'Authenticator code is incorrect');return true}db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(user.user_id);send(res,200,{ok:true});return true}
  if(req.method==='POST'&&url.pathname==='/api/security/mfa/disable'){const d=await body(req),row=db.prepare('SELECT password_hash,totp_secret FROM users WHERE id=?').get(user.user_id);if(!passwordMatches(String(d.password||''),row.password_hash)||!verifyTotp(row.totp_secret,d.code)){fail(res,401,'Password or authenticator code is incorrect');return true}db.prepare("UPDATE users SET mfa_enabled=0,totp_secret='' WHERE id=?").run(user.user_id);send(res,200,{ok:true});return true}
  return false;
 }
 return{handlePublic,handleProtected,sendVerification,checkLogin,totp};
}

module.exports={initSecurity,totp,verifyTotp};
