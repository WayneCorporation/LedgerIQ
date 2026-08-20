const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createDatabase}=require('../database');

function loadEnv(){const file=path.join(__dirname,'..','.env');if(!fs.existsSync(file))return;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const match=line.match(/^([A-Z0-9_]+)=(.*)$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].trim()}}
loadEnv();
const explicit=process.argv[2],dataDir=path.join(__dirname,'..','data'),sourcePath=path.resolve(explicit||path.join(dataDir,'ledgeriq.sqlite'));
if(!process.env.DATABASE_URL){console.error('DATABASE_URL is required');process.exit(2)}
if(!fs.existsSync(sourcePath)){console.error(`SQLite source not found: ${sourcePath}`);process.exit(2)}
const root=path.join(__dirname,'..'),initialized=spawnSync(process.execPath,['server.js'],{cwd:root,env:{...process.env,NODE_ENV:'development',INITIALIZE_DATABASE_ONLY:'true',DISABLE_AUTOMATED_BACKUPS:'true'},encoding:'utf8',timeout:60000});if(initialized.status!==0){console.error(`Could not initialize PostgreSQL schema: ${initialized.stderr||initialized.stdout}`);process.exit(1)}
const source=new DatabaseSync(sourcePath,{readOnly:true}),target=createDatabase({connectionString:process.env.DATABASE_URL});
const tables=['tenants','users','organizations','memberships','sessions','invitations','clients','invoices','invoice_items','expenses','audit_logs','approval_requests','integration_connections','bank_accounts','bank_transactions','payroll_runs','business_documents','recurring_templates','stored_files','api_keys','webhook_endpoints','background_jobs','integration_snapshots','approval_rules','approval_decisions','notifications','webhook_deliveries','oauth_states','chart_accounts','journal_entries','journal_lines','accounting_periods','auth_tokens','api_idempotency','billing_webhook_events'];
try{
 const existing=target.prepare('SELECT COUNT(*) count FROM tenants').get()?.count||0;if(existing)throw new Error('PostgreSQL target is not empty; migration refused');
 target.exec('BEGIN');
 for(const table of tables){
  const exists=source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);if(!exists)continue;
  const columns=source.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name),rows=source.prepare(`SELECT * FROM ${table}`).all();if(!columns.length)continue;
  const statement=target.prepare(`INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);for(const row of rows)statement.run(...columns.map(column=>row[column]));console.log(`${table}: ${rows.length}`);
 }
 for(const table of ['clients','invoices','invoice_items','expenses','audit_logs'])target.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM ${table}`);
 target.exec('COMMIT');console.log(`Migration completed from ${sourcePath}`);
}catch(error){try{target.exec('ROLLBACK')}catch{}console.error(`Migration failed: ${error.message}`);process.exitCode=1}finally{source.close();target.close()}
