const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync}=require('node:child_process');
const { createDatabase } = require('./database');
const { initEnterprise } = require('./enterprise');
const { initSecurity } = require('./security');
const { reportError,checkMonitoring,uploadBackup,operationalState } = require('./operations');

loadEnv();
validateProductionConfig();
const SESSION_SECRET=process.env.SESSION_SECRET||'ledgeriq-local-development-only';
const ROOT = __dirname;
const DATA_DIR = process.env.LEDGERIQ_DATA_DIR || (process.env.VERCEL ? os.tmpdir() : path.join(ROOT, 'data'));
const BACKUP_DIR = process.env.LEDGERIQ_BACKUP_DIR || (process.env.VERCEL ? os.tmpdir() : path.join(ROOT, 'backups'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const DB_PATH=path.join(DATA_DIR,'ledgeriq.sqlite');
const db = createDatabase({file:DB_PATH});
if(db.dialect==='sqlite')db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_name TEXT NOT NULL, email TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '', tax_id TEXT NOT NULL DEFAULT '', vat_number TEXT NOT NULL DEFAULT '',
 address TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'ZAR', logo TEXT NOT NULL DEFAULT '',
 subscription_status TEXT NOT NULL DEFAULT 'trialing', trial_ends_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
 id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 organization_id TEXT,
 name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', vat_number TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#e7dcff', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);
CREATE TABLE IF NOT EXISTS invoices (
 id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 organization_id TEXT,
 number TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id), issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue')),
 tax_rate REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
 payment_details TEXT NOT NULL DEFAULT '', sent_at TEXT, paid_date TEXT, created_at TEXT NOT NULL,
 UNIQUE(organization_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE TABLE IF NOT EXISTS invoice_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
 description TEXT NOT NULL, quantity REAL NOT NULL, rate REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
 id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 organization_id TEXT,
 reference TEXT NOT NULL, vendor TEXT NOT NULL, category TEXT NOT NULL, expense_date TEXT NOT NULL, due_date TEXT NOT NULL,
 amount REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('due','paid','overdue')), paid_date TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 UNIQUE(organization_id, reference)
);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id);
`);
const tenantColumns=db.prepare('PRAGMA table_info(tenants)').all().map(row=>row.name);
if(!tenantColumns.includes('paystack_customer_code'))db.exec('ALTER TABLE tenants ADD COLUMN paystack_customer_code TEXT');
if(!tenantColumns.includes('paystack_subscription_code'))db.exec('ALTER TABLE tenants ADD COLUMN paystack_subscription_code TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS billing_webhook_events(id TEXT PRIMARY KEY,provider TEXT NOT NULL,payload_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);`);

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const rateBuckets = new Map();
const colours = ['#e7dcff','#d9e9ff','#ffded0','#dff2d4','#ffe8b8'];
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.ico':'image/x-icon' };

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}
function validateProductionConfig(){
 if(process.env.NODE_ENV!=='production')return;
 const errors=[];
 if(String(process.env.SESSION_SECRET||'').length<32)errors.push('SESSION_SECRET must contain at least 32 characters');
 if(String(process.env.INTEGRATION_ENCRYPTION_KEY||'').length<32)errors.push('INTEGRATION_ENCRYPTION_KEY must contain at least 32 characters');
 try{if(new URL(process.env.APP_ORIGIN||'').protocol!=='https:')errors.push('APP_ORIGIN must be an HTTPS origin')}catch{errors.push('APP_ORIGIN must be a valid HTTPS origin')}
 if(Boolean(process.env.RESEND_API_KEY)!==Boolean(process.env.MAIL_FROM))errors.push('RESEND_API_KEY and MAIL_FROM must be configured together');
 if(process.env.REQUIRE_EMAIL_VERIFICATION!=='false'&&(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM))errors.push('Transactional email is required when production email verification is enabled');
 if(process.env.PAYSTACK_SECRET_KEY&&(!process.env.PAYSTACK_MONTHLY_PLAN_CODE||!process.env.PAYSTACK_ANNUAL_PLAN_CODE))errors.push('Both Paystack plan codes are required when Paystack is enabled');
 if(process.env.OFFSITE_BACKUP_URL&&String(process.env.BACKUP_ENCRYPTION_KEY||'').length<32)errors.push('BACKUP_ENCRYPTION_KEY must contain at least 32 characters when offsite backups are enabled');
 if(process.env.OBJECT_STORAGE_ENDPOINT&&(!process.env.OBJECT_STORAGE_BUCKET||!process.env.OBJECT_STORAGE_ACCESS_KEY||!process.env.OBJECT_STORAGE_SECRET_KEY))errors.push('Object storage endpoint, bucket and credentials must all be configured');
 if(errors.length)throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
}
function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function hash(value) { return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('hex'); }
function clean(value, max=500) { return String(value ?? '').trim().slice(0, max); }
function email(value) { const result=clean(value,254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : ''; }
function date(value) { const result=clean(value,10); return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : ''; }
function money(value) { const result=Number(value); return Number.isFinite(result) && result >= 0 && result <= 1e9 ? result : NaN; }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function passwordHash(password, salt=crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password,salt,64).toString('hex')}`; }
function passwordMatches(password, stored) { const [salt, expected]=stored.split(':'); const actual=crypto.scryptSync(password,salt,64); return expected && crypto.timingSafeEqual(actual,Buffer.from(expected,'hex')); }
function cookies(req) { return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i).trim(),decodeURIComponent(v.slice(i+1))]})); }
function sessionCookie(value, clear=false) { return `ledgeriq_session=${clear?'':encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${clear?0:SESSION_DAYS*86400}${process.env.NODE_ENV==='production'?'; Secure':''}`; }
function send(res,status,body,headers={}) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body)); }
function fail(res,status,error) { send(res,status,{error}); }
async function body(req) { let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>7_500_000) throw new Error('Request too large'); } req.rawBody=raw;if(!raw)return{};try{return JSON.parse(raw)}catch{throw new Error('Invalid JSON')} }
function clientIp(req){if(process.env.TRUST_PROXY==='true'){const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();if(forwarded)return forwarded.slice(0,100)}return req.socket?.remoteAddress||''}
function limited(req,key,limit=10,windowMs=15*60_000) { const bucketKey=`${clientIp(req)}:${key}`, t=Date.now(), recent=(rateBuckets.get(bucketKey)||[]).filter(x=>t-x<windowMs); recent.push(t);rateBuckets.set(bucketKey,recent);return recent.length>limit; }
function originAllowed(req) { if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return true; const origin=req.headers.origin; if(!origin)return true; const allowed=process.env.APP_ORIGIN||`http://${req.headers.host}`;return origin===allowed; }
function currentUser(req) { const jar=cookies(req),raw=jar.ledgeriq_session;if(!raw)return null;const row=db.prepare(`SELECT u.id user_id,u.email,u.email_verified_at,m.tenant_id,m.organization_id,m.role,o.name company_name,t.subscription_status,t.trial_ends_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id AND m.organization_id=u.active_organization_id JOIN organizations o ON o.id=m.organization_id JOIN tenants t ON t.id=m.tenant_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(raw),now());return row||null; }
function currentApiKey(req){const authorization=req.headers.authorization||'',supported=authorization.startsWith('Bearer lq_');if(!supported)return null;const raw=authorization.slice(7),row=db.prepare(`SELECT k.id key_id,k.tenant_id,k.organization_id,k.scopes,k.created_by user_id,u.email,o.name company_name,t.subscription_status,t.trial_ends_at FROM api_keys k JOIN users u ON u.id=k.created_by JOIN organizations o ON o.id=k.organization_id JOIN tenants t ON t.id=k.tenant_id WHERE k.key_hash=? AND k.revoked_at IS NULL`).get(hash(raw));if(!row)return null;db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(),row.key_id);const scopes=JSON.parse(row.scopes||'[]');return{...row,api_scopes:scopes,via_api_key:true,role:scopes.includes('write')?'admin':'viewer'};}
function requireUser(req,res) { const user=currentUser(req)||currentApiKey(req);if(!user)fail(res,401,'Please sign in');return user; }
function createSession(res,userId) { const raw=token(),created=now(),expires=new Date(Date.now()+SESSION_DAYS*86400000).toISOString();db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(raw),userId,expires,created);return sessionCookie(raw); }
function profile(tenantId,organizationId) { return db.prepare(`SELECT o.name companyName,t.owner_name ownerName,o.email,o.phone,o.registration_number taxId,o.vat_number vatNumber,o.address,o.currency,o.logo,t.subscription_status subscriptionStatus,t.trial_ends_at trialEndsAt FROM organizations o JOIN tenants t ON t.id=o.tenant_id WHERE o.id=? AND o.tenant_id=?`).get(organizationId,tenantId); }
function invoiceRows(tenantId,organizationId) { const rows=db.prepare(`SELECT id,number,client_id clientId,issue_date issue,due_date due,status,tax_rate taxRate,discount,notes,payment_details paymentDetails,sent_at sentAt,paid_date paidDate FROM invoices WHERE tenant_id=? AND organization_id=? ORDER BY issue_date DESC,id DESC`).all(tenantId,organizationId);const items=db.prepare('SELECT description,quantity qty,unit,rate FROM invoice_items WHERE invoice_id=? ORDER BY id');return rows.map(r=>({...r,items:items.all(r.id)})); }
function bootstrap(tenantId,organizationId) { db.prepare(`UPDATE invoices SET status='overdue' WHERE tenant_id=? AND organization_id=? AND status='sent' AND due_date<?`).run(tenantId,organizationId,now().slice(0,10));db.prepare(`UPDATE expenses SET status='overdue' WHERE tenant_id=? AND organization_id=? AND status='due' AND due_date<?`).run(tenantId,organizationId,now().slice(0,10));return {profile:profile(tenantId,organizationId),clients:db.prepare('SELECT id,name,email,address,vat_number vatNumber,color FROM clients WHERE tenant_id=? AND organization_id=? ORDER BY name').all(tenantId,organizationId),invoices:invoiceRows(tenantId,organizationId),expenses:db.prepare(`SELECT id,reference,vendor,category,expense_date date,due_date due,amount,status,paid_date paidDate,notes FROM expenses WHERE tenant_id=? AND organization_id=? ORDER BY expense_date DESC,id DESC`).all(tenantId,organizationId)}; }
function transaction(fn) { db.exec(db.dialect==='postgres'?'BEGIN':'BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error} }
function insertItems(invoiceId,items) { const stmt=db.prepare('INSERT INTO invoice_items(invoice_id,description,quantity,rate,unit) VALUES(?,?,?,?,?)');for(const item of items){const description=clean(item.description,300),qty=Number(item.qty),rate=money(item.rate),unit=clean(item.unit,30);if(!description||!Number.isFinite(qty)||qty<=0||Number.isNaN(rate))throw new Error('Every line item needs a valid description, quantity and rate');stmt.run(invoiceId,description,qty,rate,unit);} }
function invoiceTotal(invoice) { const subtotal=invoice.items.reduce((s,i)=>s+Number(i.qty)*Number(i.rate),0);const discounted=Math.max(0,subtotal-Number(invoice.discount||0));return discounted*(1+Number(invoice.taxRate||0)/100); }
function invoiceEmail(invoice,client,p) { const rows=invoice.items.map(i=>`<tr><td>${escapeHTML(i.description)}</td><td>${i.qty}</td><td>${i.rate.toFixed(2)}</td></tr>`).join('');return `<h1>Invoice ${escapeHTML(invoice.number)}</h1><p>From ${escapeHTML(p.companyName)}</p><p>Due ${escapeHTML(invoice.due)}</p><table><tr><th>Description</th><th>Qty</th><th>Rate</th></tr>${rows}</table><h2>Total: ${escapeHTML(p.currency)} ${invoiceTotal(invoice).toFixed(2)}</h2><p>${escapeHTML(invoice.paymentDetails||invoice.notes)}</p>`; }
async function sendInvoiceEmail(invoice,client,p) { if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)throw new Error('Email delivery is not configured');const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:[client.email],subject:`Invoice ${invoice.number} from ${p.companyName}`,html:invoiceEmail(invoice,client,p)})});if(!response.ok)throw new Error('Email provider rejected the message'); }

const enterprise=initEnterprise(db,{send,fail,body,clean,now,id,email,hash,operationalState,clientIp,money,date,transaction});
const security=initSecurity(db,{send,fail,body,clean,now,id,email,hash,passwordHash,passwordMatches});
db.exec(`CREATE TABLE IF NOT EXISTS api_idempotency(id TEXT PRIMARY KEY,api_key_id TEXT NOT NULL,idempotency_hash TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,response_status INTEGER NOT NULL,response_body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(api_key_id,idempotency_hash));`);
if(process.env.INITIALIZE_DATABASE_ONLY==='true'){console.log(`ledgerIQ ${db.dialect} schema initialized`);db.close();process.exit(0)}

async function api(req,res,url) {
  if(!originAllowed(req))return fail(res,403,'Invalid request origin');
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,time:now()});
  if(req.method==='GET'&&url.pathname==='/api/ready'){
    try{db.prepare('SELECT 1').get();fs.accessSync(DATA_DIR,fs.constants.R_OK|fs.constants.W_OK);const ops=operationalState(),backupRequired=Boolean(process.env.OFFSITE_BACKUP_URL),monitoringRequired=Boolean(process.env.MONITORING_DSN),ready=(!backupRequired||Boolean(ops.lastBackupSuccess))&&(!monitoringRequired||Boolean(ops.lastMonitoringSuccess));return send(res,ready?200:503,{ready,database:true,dataDirectory:true,offsiteBackup:backupRequired?Boolean(ops.lastBackupSuccess):null,monitoring:monitoringRequired?Boolean(ops.lastMonitoringSuccess):null});}catch(error){return send(res,503,{ready:false,database:false,error:'Dependency check failed'})}
  }
  if(await security.handlePublic(req,res,url))return;
  if(req.method==='POST'&&url.pathname==='/api/auth/register'){
    if(limited(req,'register',5))return fail(res,429,'Too many attempts. Try again later.');
    const data=await body(req),userEmail=email(data.email),password=String(data.password||''),company=clean(data.companyName,120),owner=clean(data.ownerName,120);
    if(!userEmail||password.length<10||!company||!owner)return fail(res,400,'Use a valid email, a 10+ character password, and complete all fields');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(userEmail))return fail(res,409,'An account with this email already exists');
    const tenantId=id(),userId=id(),created=now(),trial=new Date(Date.now()+30*86400000).toISOString();
    transaction(()=>{db.prepare(`INSERT INTO tenants(id,name,owner_name,email,address,currency,trial_ends_at,created_at) VALUES(?,?,?,?,?,'ZAR',?,?)`).run(tenantId,company,owner,userEmail,'',trial,created);db.prepare('INSERT INTO users(id,tenant_id,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(userId,tenantId,userEmail,passwordHash(password),created);enterprise.createPrimaryOrganization(tenantId,userId,{companyName:company,email:userEmail})});
    const verification=await security.sendVerification(userId,userEmail);
    return send(res,201,{ok:true,emailVerificationSent:verification.sent,...(verification.token?{verificationToken:verification.token}:{})},{'Set-Cookie':createSession(res,userId)});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){
    if(limited(req,'login'))return fail(res,429,'Too many attempts. Try again later.');
    const data=await body(req),userEmail=email(data.email),row=db.prepare('SELECT id,password_hash,totp_secret,mfa_enabled FROM users WHERE email=?').get(userEmail);
    if(!row||!passwordMatches(String(data.password||''),row.password_hash))return fail(res,401,'Email or password is incorrect');
    if(!security.checkLogin(row,data.mfaCode))return fail(res,401,'Enter the current 6-digit authenticator code');
    return send(res,200,{ok:true},{'Set-Cookie':createSession(res,row.id)});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const jar=cookies(req),raw=jar.ledgeriq_session;if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(raw));return send(res,200,{ok:true},{'Set-Cookie':[sessionCookie('',true)]});}
  if(req.method==='GET'&&url.pathname==='/api/me'){const user=currentUser(req);return user?send(res,200,user):fail(res,401,'Please sign in');}
  if(req.method==='POST'&&url.pathname==='/api/billing/webhook'){
    const raw=await body(req),paystackSignature=req.headers['x-paystack-signature']||'',genericSignature=req.headers['x-ledgeriq-signature']||'';let customerEmail='',status='',provider='generic',tenantId='',customerCode='',subscriptionCode='';
    if(paystackSignature&&process.env.PAYSTACK_SECRET_KEY){const expected=crypto.createHmac('sha512',process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');if(paystackSignature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(paystackSignature),Buffer.from(expected)))return fail(res,401,'Invalid Paystack signature');provider='paystack';customerEmail=email(raw.data?.customer?.email||raw.data?.email);tenantId=clean(raw.data?.metadata?.tenant_id,100);customerCode=clean(raw.data?.customer?.customer_code,100);subscriptionCode=clean(raw.data?.subscription_code||raw.data?.subscription?.subscription_code,100);const planCode=clean(raw.data?.plan?.plan_code||raw.data?.subscription?.plan?.plan_code,100),knownPlans=[process.env.PAYSTACK_MONTHLY_PLAN_CODE,process.env.PAYSTACK_ANNUAL_PLAN_CODE].filter(Boolean);status=raw.event==='subscription.disable'?'cancelled':raw.event==='invoice.payment_failed'?'past_due':['subscription.create','charge.success'].includes(raw.event)&&knownPlans.includes(planCode)?'active':'';}
    else{const secret=process.env.BILLING_WEBHOOK_SECRET||'',expected=crypto.createHmac('sha256',secret).update(req.rawBody).digest('hex');if(!secret||genericSignature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(genericSignature),Buffer.from(expected)))return fail(res,401,'Invalid signature');customerEmail=email(raw.email);status=raw.status;}
    const payloadHash=crypto.createHash('sha256').update(req.rawBody).digest('hex');if(db.prepare('SELECT 1 FROM billing_webhook_events WHERE payload_hash=?').get(payloadHash))return send(res,200,{ok:true,replayed:true});
    const owner=tenantId?db.prepare('SELECT id tenant_id FROM tenants WHERE id=?').get(tenantId):db.prepare('SELECT tenant_id FROM users WHERE email=?').get(customerEmail);if(owner&&['active','past_due','cancelled'].includes(status))transaction(()=>{db.prepare('UPDATE tenants SET subscription_status=?,paystack_customer_code=COALESCE(NULLIF(?,\'\'),paystack_customer_code),paystack_subscription_code=COALESCE(NULLIF(?,\'\'),paystack_subscription_code) WHERE id=?').run(status,customerCode,subscriptionCode,owner.tenant_id);db.prepare('INSERT INTO billing_webhook_events VALUES(?,?,?,?)').run(id(),provider,payloadHash,now())});return send(res,200,{ok:true,processed:Boolean(owner&&status)});
  }
  const user=requireUser(req,res);if(!user)return;
  if(user.via_api_key){const mutation=['POST','PUT','PATCH','DELETE'].includes(req.method);if(mutation&&!user.api_scopes.includes('write'))return fail(res,403,'This API key is read-only');if(['/api/account','/api/billing','/api/auth','/api/enterprise/api-keys','/api/enterprise/webhooks'].some(prefix=>url.pathname.startsWith(prefix)))return fail(res,403,'API keys cannot access account security or credential-management endpoints');}
  if(user.via_api_key&&req.method==='POST'){
    const idempotencyKey=clean(req.headers['idempotency-key'],200);if(!idempotencyKey)return fail(res,400,'API POST requests require an Idempotency-Key header');const idempotencyHash=hash(`${user.key_id}:${idempotencyKey}`),saved=db.prepare('SELECT response_status,response_body FROM api_idempotency WHERE api_key_id=? AND idempotency_hash=?').get(user.key_id,idempotencyHash);if(saved){res.writeHead(saved.response_status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Idempotent-Replayed':'true'});res.end(saved.response_body);return}const originalEnd=res.end.bind(res);res.end=(chunk,...args)=>{const responseBody=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk||'');if(res.statusCode<500&&!res.headersSent){}try{if(res.statusCode<500)db.prepare('INSERT OR IGNORE INTO api_idempotency VALUES(?,?,?,?,?,?,?,?)').run(id(),user.key_id,idempotencyHash,req.method,url.pathname,res.statusCode,responseBody,now())}catch{}return originalEnd(chunk,...args)};
  }
  const paidOrTrial=user.subscription_status==='active'||(user.subscription_status==='trialing'&&user.trial_ends_at>now());
  const protectedWrite=['/api/clients','/api/invoices','/api/expenses','/api/enterprise'].some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix+'/'))&&['POST','PUT','PATCH','DELETE'].includes(req.method);
  const verificationRequired=process.env.REQUIRE_EMAIL_VERIFICATION==='true'||(process.env.NODE_ENV==='production'&&process.env.REQUIRE_EMAIL_VERIFICATION!=='false');
  if(protectedWrite&&!user.via_api_key&&verificationRequired&&!user.email_verified_at)return fail(res,403,'Verify your email before changing financial data.');
  if(protectedWrite&&!paidOrTrial)return fail(res,402,'Your trial has ended. Choose a plan to keep creating and updating records.');
  if(!user.via_api_key&&await security.handleProtected(req,res,url,user))return;
  if(await enterprise.handle(req,res,url,user))return;
  if(req.method==='GET'&&url.pathname==='/api/bootstrap')return send(res,200,bootstrap(user.tenant_id,user.organization_id));
  if(req.method==='PUT'&&url.pathname==='/api/profile'){
    if(!enterprise.requirePermission(user,res,'manage_org'))return;
    const d=await body(req),companyName=clean(d.companyName,120),ownerName=clean(d.ownerName,120),userEmail=email(d.email),currency=clean(d.currency,3);
    if(!companyName||!ownerName||!userEmail||!['ZAR','EUR','USD','GBP','AUD','CAD','NGN','KES'].includes(currency))return fail(res,400,'Invalid business profile');
    db.prepare(`UPDATE tenants SET owner_name=? WHERE id=?`).run(ownerName,user.tenant_id);db.prepare(`UPDATE organizations SET name=?,legal_name=CASE WHEN legal_name='' THEN ? ELSE legal_name END,email=?,phone=?,registration_number=?,vat_number=?,address=?,currency=?,logo=? WHERE id=? AND tenant_id=?`).run(companyName,companyName,userEmail,clean(d.phone,40),clean(d.taxId,80),clean(d.vatNumber,80),clean(d.address,500),currency,clean(d.logo,700000),user.organization_id,user.tenant_id);enterprise.audit(user,'updated','organization',user.organization_id,{companyName},clientIp(req));return send(res,200,{profile:profile(user.tenant_id,user.organization_id)});
  }
  if(req.method==='POST'&&url.pathname==='/api/clients'){
    if(!enterprise.requirePermission(user,res,'manage_finance'))return;
    const d=await body(req),name=clean(d.name,150),clientEmail=d.email?email(d.email):'';if(!name||(d.email&&!clientEmail))return fail(res,400,'Enter a valid client name and email');
    const result=db.prepare(`INSERT INTO clients(tenant_id,organization_id,name,email,address,vat_number,color,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(user.tenant_id,user.organization_id,name,clientEmail,clean(d.address,500),clean(d.vatNumber,80),colours[Number(db.prepare('SELECT COUNT(*) n FROM clients WHERE organization_id=?').get(user.organization_id).n)%colours.length],now());enterprise.audit(user,'created','client',result.lastInsertRowid,{name},clientIp(req));return send(res,201,{id:Number(result.lastInsertRowid)});
  }
  let match=url.pathname.match(/^\/api\/clients\/(\d+)$/);
  if(match&&req.method==='PUT'){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),name=clean(d.name,150),clientEmail=d.email?email(d.email):'';if(!name||(d.email&&!clientEmail))return fail(res,400,'Enter a valid client name and email');const result=db.prepare(`UPDATE clients SET name=?,email=?,address=?,vat_number=? WHERE tenant_id=? AND organization_id=? AND id=?`).run(name,clientEmail,clean(d.address,500),clean(d.vatNumber,80),user.tenant_id,user.organization_id,match[1]);if(!result.changes)return fail(res,404,'Client not found');enterprise.audit(user,'updated','client',match[1],{name},clientIp(req));return send(res,200,{ok:true});}
  if(match&&req.method==='DELETE'){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const used=db.prepare('SELECT 1 FROM invoices WHERE tenant_id=? AND organization_id=? AND client_id=?').get(user.tenant_id,user.organization_id,match[1]);if(used)return fail(res,409,'Delete this client’s invoices first');db.prepare('DELETE FROM clients WHERE tenant_id=? AND organization_id=? AND id=?').run(user.tenant_id,user.organization_id,match[1]);enterprise.audit(user,'deleted','client',match[1],{},clientIp(req));return send(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/invoices'){
    if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),number=clean(d.number,50),issue=date(d.issue),due=date(d.due),client=db.prepare('SELECT id FROM clients WHERE id=? AND tenant_id=? AND organization_id=?').get(Number(d.clientId),user.tenant_id,user.organization_id),taxRate=Number(d.taxRate||0),discount=money(d.discount||0);
    if(!number||!issue||!due||due<issue||!client||!Array.isArray(d.items)||!d.items.length||!Number.isFinite(taxRate)||taxRate<0||taxRate>100||Number.isNaN(discount))return fail(res,400,'Check the invoice details');
    try{const invoiceId=transaction(()=>{const result=db.prepare(`INSERT INTO invoices(tenant_id,organization_id,number,client_id,issue_date,due_date,tax_rate,discount,notes,payment_details,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(user.tenant_id,user.organization_id,number,client.id,issue,due,taxRate,discount,clean(d.notes,1000),clean(d.paymentDetails,1000),now());insertItems(Number(result.lastInsertRowid),d.items);return Number(result.lastInsertRowid)});enterprise.audit(user,'created','invoice',invoiceId,{number,total:d.items.reduce((s,i)=>s+Number(i.qty)*Number(i.rate),0)},clientIp(req));return send(res,201,{id:invoiceId});}catch(error){return fail(res,400,error.message.includes('UNIQUE')?'Invoice number already exists':error.message);}
  }
  match=url.pathname.match(/^\/api\/invoices\/(\d+)(?:\/(send))?$/);
  if(match&&req.method==='PUT'&&!match[2]){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),number=clean(d.number,50),issue=date(d.issue),due=date(d.due),client=db.prepare('SELECT id FROM clients WHERE id=? AND tenant_id=? AND organization_id=?').get(Number(d.clientId),user.tenant_id,user.organization_id),taxRate=Number(d.taxRate||0),discount=money(d.discount||0),existing=db.prepare('SELECT id FROM invoices WHERE id=? AND tenant_id=? AND organization_id=?').get(match[1],user.tenant_id,user.organization_id);if(!existing)return fail(res,404,'Invoice not found');if(!number||!issue||!due||due<issue||!client||!Array.isArray(d.items)||!d.items.length||!Number.isFinite(taxRate)||taxRate<0||taxRate>100||Number.isNaN(discount))return fail(res,400,'Check the invoice details');try{transaction(()=>{db.prepare(`UPDATE invoices SET number=?,client_id=?,issue_date=?,due_date=?,tax_rate=?,discount=?,notes=?,payment_details=? WHERE id=? AND tenant_id=? AND organization_id=?`).run(number,client.id,issue,due,taxRate,discount,clean(d.notes,1000),clean(d.paymentDetails,1000),match[1],user.tenant_id,user.organization_id);db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(match[1]);insertItems(Number(match[1]),d.items)});enterprise.audit(user,'updated','invoice',match[1],{number},clientIp(req));return send(res,200,{ok:true});}catch(error){return fail(res,400,error.message.includes('UNIQUE')?'Invoice number already exists':error.message);}}
  if(match&&req.method==='PATCH'&&!match[2]){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),status=clean(d.status,10);if(!['draft','sent','paid','overdue'].includes(status))return fail(res,400,'Invalid status');db.prepare(`UPDATE invoices SET status=?,paid_date=CASE WHEN ?='paid' THEN ? ELSE paid_date END WHERE id=? AND tenant_id=? AND organization_id=?`).run(status,status,date(d.paidDate)||now().slice(0,10),match[1],user.tenant_id,user.organization_id);enterprise.audit(user,'status_changed','invoice',match[1],{status},clientIp(req));return send(res,200,{ok:true});}
  if(match&&req.method==='DELETE'&&!match[2]){if(!enterprise.requirePermission(user,res,'manage_finance'))return;db.prepare('DELETE FROM invoices WHERE id=? AND tenant_id=? AND organization_id=?').run(match[1],user.tenant_id,user.organization_id);enterprise.audit(user,'deleted','invoice',match[1],{},clientIp(req));return send(res,200,{ok:true});}
  if(match&&req.method==='POST'&&match[2]==='send'){
    if(!enterprise.requirePermission(user,res,'manage_finance'))return;const invoice=invoiceRows(user.tenant_id,user.organization_id).find(i=>i.id===Number(match[1]));if(!invoice)return fail(res,404,'Invoice not found');const client=db.prepare('SELECT * FROM clients WHERE id=? AND tenant_id=? AND organization_id=?').get(invoice.clientId,user.tenant_id,user.organization_id);if(!client.email)return fail(res,400,'Add an email address to this client first');
    try{await sendInvoiceEmail(invoice,client,profile(user.tenant_id,user.organization_id));db.prepare(`UPDATE invoices SET status='sent',sent_at=? WHERE id=? AND tenant_id=? AND organization_id=?`).run(now(),invoice.id,user.tenant_id,user.organization_id);enterprise.audit(user,'sent','invoice',invoice.id,{to:client.email},clientIp(req));return send(res,200,{ok:true});}catch(error){return fail(res,503,error.message);}
  }
  if(req.method==='POST'&&url.pathname==='/api/expenses'){
    if(!enterprise.permitted(user,'manage_finance')&&!enterprise.permitted(user,'submit'))return fail(res,403,'Your role does not allow this action');const d=await body(req),reference=clean(d.reference,60),vendor=clean(d.vendor,150),amount=money(d.amount),expenseDate=date(d.date),dueDate=date(d.due),status=clean(d.status,10);if(!reference||!vendor||Number.isNaN(amount)||!expenseDate||!dueDate||!['due','paid','overdue'].includes(status))return fail(res,400,'Check the expense details');
    try{const result=db.prepare(`INSERT INTO expenses(tenant_id,organization_id,reference,vendor,category,expense_date,due_date,amount,status,paid_date,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.tenant_id,user.organization_id,reference,vendor,clean(d.category,80),expenseDate,dueDate,amount,status,status==='paid'?now().slice(0,10):null,clean(d.notes,1000),now());enterprise.audit(user,'created','expense',result.lastInsertRowid,{reference,amount},clientIp(req));return send(res,201,{id:Number(result.lastInsertRowid)});}catch(error){return fail(res,400,error.message.includes('UNIQUE')?'Expense reference already exists':'Could not save expense');}
  }
  match=url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if(match&&req.method==='PUT'){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),reference=clean(d.reference,60),vendor=clean(d.vendor,150),amount=money(d.amount),expenseDate=date(d.date),dueDate=date(d.due),status=clean(d.status,10);if(!reference||!vendor||Number.isNaN(amount)||!expenseDate||!dueDate||!['due','paid','overdue'].includes(status))return fail(res,400,'Check the expense details');try{const result=db.prepare(`UPDATE expenses SET reference=?,vendor=?,category=?,expense_date=?,due_date=?,amount=?,status=?,paid_date=CASE WHEN ?='paid' THEN COALESCE(paid_date,?) ELSE NULL END,notes=? WHERE tenant_id=? AND organization_id=? AND id=?`).run(reference,vendor,clean(d.category,80),expenseDate,dueDate,amount,status,status,now().slice(0,10),clean(d.notes,1000),user.tenant_id,user.organization_id,match[1]);if(!result.changes)return fail(res,404,'Expense not found');enterprise.audit(user,'updated','expense',match[1],{reference,amount},clientIp(req));return send(res,200,{ok:true});}catch(error){return fail(res,400,error.message.includes('UNIQUE')?'Expense reference already exists':'Could not update expense');}}
  if(match&&req.method==='PATCH'){if(!enterprise.requirePermission(user,res,'manage_finance'))return;const d=await body(req),status=clean(d.status,10);if(!['due','paid','overdue'].includes(status))return fail(res,400,'Invalid status');db.prepare(`UPDATE expenses SET status=?,paid_date=CASE WHEN ?='paid' THEN ? ELSE paid_date END WHERE id=? AND tenant_id=? AND organization_id=?`).run(status,status,now().slice(0,10),match[1],user.tenant_id,user.organization_id);enterprise.audit(user,'status_changed','expense',match[1],{status},clientIp(req));return send(res,200,{ok:true});}
  if(match&&req.method==='DELETE'){if(!enterprise.requirePermission(user,res,'manage_finance'))return;db.prepare('DELETE FROM expenses WHERE id=? AND tenant_id=? AND organization_id=?').run(match[1],user.tenant_id,user.organization_id);enterprise.audit(user,'deleted','expense',match[1],{},clientIp(req));return send(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/billing/checkout'){const d=await body(req),annual=d.cycle==='annual',plan=annual?process.env.PAYSTACK_ANNUAL_PLAN_CODE:process.env.PAYSTACK_MONTHLY_PLAN_CODE;if(process.env.PAYSTACK_SECRET_KEY&&plan){const response=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,amount:annual?599000:59900,plan,metadata:{tenant_id:user.tenant_id,billing_cycle:annual?'annual':'monthly'},callback_url:`${process.env.APP_ORIGIN||`http://${req.headers.host}`}/app`}),signal:AbortSignal.timeout(10000)}),result=await response.json();if(!response.ok||!result.status)return fail(res,503,'Payment provider could not start checkout');return send(res,200,{url:result.data.authorization_url});}const checkout=annual?process.env.BILLING_ANNUAL_URL:process.env.BILLING_MONTHLY_URL;if(!checkout)return fail(res,503,'Checkout is awaiting your merchant payment configuration');return send(res,200,{url:checkout});}
  if(req.method==='GET'&&url.pathname==='/api/account/export')return send(res,200,{exportedAt:now(),...bootstrap(user.tenant_id,user.organization_id),enterprise:enterprise.summary(user)});
  if(req.method==='DELETE'&&url.pathname==='/api/account'){if(user.role!=='owner')return fail(res,403,'Only the workspace owner can delete this account');const d=await body(req),row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.user_id);if(!passwordMatches(String(d.password||''),row.password_hash))return fail(res,401,'Password is incorrect');db.prepare('DELETE FROM tenants WHERE id=?').run(user.tenant_id);return send(res,200,{ok:true},{'Set-Cookie':sessionCookie('',true)});}
  return fail(res,404,'Not found');
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
}
function staticFile(req,res,url) {
  if(!['GET','HEAD'].includes(req.method))return false;
  const routes={'/':'landing.html','/app':'index.html','/privacy':'privacy.html','/terms':'terms.html','/developers':'api.html'},publicFiles=new Set(['app.js','styles.css','marketing.css','enterprise-marketing.css','legal.css']);const requested=routes[url.pathname]||decodeURIComponent(url.pathname.slice(1));
  if(!publicFiles.has(requested)&&!Object.values(routes).includes(requested))return false;const resolved=path.join(ROOT,requested);
  const stat=fs.statSync(resolved),range=req.headers.range;res.setHeader('Content-Type',mime[path.extname(resolved).toLowerCase()]||'application/octet-stream');res.setHeader('Cache-Control',path.extname(resolved)==='.html'?'no-cache':'public, max-age=3600');
  if(range){const match=range.match(/^bytes=(\d+)-(\d*)$/),start=match?Number(match[1]):NaN,end=match&&match[2]?Number(match[2]):stat.size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=stat.size||end>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return true;}res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1});if(req.method==='HEAD')res.end();else fs.createReadStream(resolved,{start,end}).pipe(res);return true;}
  res.writeHead(200,{'Content-Length':stat.size});if(req.method==='HEAD')res.end();else fs.createReadStream(resolved).pipe(res);return true;
}
async function requestHandler(req,res){securityHeaders(res);try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/'))return await api(req,res,url);if(!staticFile(req,res,url))fail(res,404,'Not found');}catch(error){const status=error.message==='Request too large'?413:error.message==='Invalid JSON'?400:500;if(status>=500){console.error(error);reportError(error,{method:req.method,url:req.url}).catch(()=>{})}fail(res,status,status===400?'Request body must be valid JSON':status===413?'Request too large':(process.env.DEBUG_ERRORS==='true'?`${error.message}\n${error.stack}`:'Something went wrong'));}}

async function backupDatabase(){try{const dateStamp=new Date().toISOString().slice(0,10),extension=db.dialect==='postgres'?'dump':'sqlite',filename=`ledgeriq-${dateStamp}.${extension}`,file=path.join(BACKUP_DIR,filename);if(!fs.existsSync(file)){if(db.dialect==='postgres'){const result=spawnSync('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',file,process.env.DATABASE_URL],{encoding:'utf8',timeout:120000});if(result.status!==0)throw new Error(`pg_dump failed: ${String(result.stderr||result.error?.message||'unknown error').slice(0,500)}`)}else{const target=file.replaceAll("'","''");db.exec(`VACUUM INTO '${target}'`)}}if(process.env.OFFSITE_BACKUP_URL)await uploadBackup(file);const files=fs.readdirSync(BACKUP_DIR).filter(f=>/\.(sqlite|dump)$/.test(f)).sort().reverse();for(const old of files.slice(7))fs.unlinkSync(path.join(BACKUP_DIR,old));}catch(error){console.error('Backup failed',error);reportError(error,{operation:'backup'}).catch(()=>{});}}
async function runMaintenance(){await enterprise.runJobs().catch(error=>console.error('Background job failed',error));db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());db.prepare('DELETE FROM auth_tokens WHERE expires_at<?').run(now());db.prepare('DELETE FROM api_idempotency WHERE created_at<?').run(new Date(Date.now()-24*60*60*1000).toISOString());for(const [key,times] of rateBuckets)if(!times.some(t=>Date.now()-t<15*60_000))rateBuckets.delete(key);}

if(process.env.VERCEL){
  module.exports=requestHandler;
  module.exports.runMaintenance=runMaintenance;
} else {
  const server=http.createServer(requestHandler);
  server.listen(PORT,()=>console.log(`ledgerIQ running on http://localhost:${PORT}`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>{db.close();process.exit(0)}));
  if(process.env.DISABLE_AUTOMATED_BACKUPS!=='true'){backupDatabase();setInterval(backupDatabase,24*60*60*1000).unref()}
  if(process.env.MONITORING_DSN)checkMonitoring().catch(()=>{});
  setInterval(()=>enterprise.runJobs().catch(error=>console.error('Background job failed',error)),10_000).unref();
  setInterval(()=>{db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());db.prepare('DELETE FROM auth_tokens WHERE expires_at<?').run(now());db.prepare('DELETE FROM api_idempotency WHERE created_at<?').run(new Date(Date.now()-24*60*60*1000).toISOString());for(const [key,times] of rateBuckets)if(!times.some(t=>Date.now()-t<15*60_000))rateBuckets.delete(key);},60*60*1000).unref();
}
