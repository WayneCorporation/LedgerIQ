const {workerData}=require('node:worker_threads');
const {Client,types}=require('pg');
types.setTypeParser(20,value=>Number(value));
types.setTypeParser(1700,value=>Number(value));

const port=workerData.port;
let client;
const ready=(async()=>{
 const sslMode=process.env.DATABASE_SSL||'';
 client=new Client({connectionString:workerData.connectionString,connectionTimeoutMillis:15000,...(sslMode?{ssl:{rejectUnauthorized:sslMode!=='require'}}:{})});await client.connect();
 if(workerData.reset){await client.query('DROP SCHEMA IF EXISTS public CASCADE');await client.query('CREATE SCHEMA public')}
})();

function placeholders(sql){let index=0,inQuote=false,result='';for(let i=0;i<sql.length;i++){const char=sql[i];if(char==="'"&&sql[i+1]==="'"){result+="''";i++;continue}if(char==="'")inQuote=!inQuote;if(char==='?'&&!inQuote)result+=`$${++index}`;else result+=char}return result}
function quoteAliases(sql){let result='',inQuote=false,i=0;while(i<sql.length){const char=sql[i];if(char==="'"&&sql[i+1]==="'"){result+="''";i+=2;continue}if(char==="'"){inQuote=!inQuote;result+=char;i++;continue}if(!inQuote&&/[A-Za-z_]/.test(char)){let j=i+1;while(j<sql.length&&/[A-Za-z0-9_]/.test(sql[j]))j++;const word=sql.slice(i,j);result+=(/[a-z]/.test(word)&&/[A-Z]/.test(word))?`"${word}"`:word;i=j;continue}result+=char;i++}return result}
function translate(sql,{run=false}={}){
 const pragma=String(sql).trim().match(/^PRAGMA\s+table_info\(([^)]+)\)/i);if(pragma)return{sql:'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1',params:[pragma[1].trim()]};
 let value=String(sql).replace(/PRAGMA\s+[^;]+;?/gi,'').replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,'SERIAL PRIMARY KEY').replace(/\bREAL\b/gi,'NUMERIC(18,4)').replace(/\s+COLLATE\s+NOCASE/gi,'').trim();
 value=quoteAliases(value);
 const ignored=/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(value);value=value.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi,'INSERT INTO');value=placeholders(value).replace(/;\s*$/,'');
 if(ignored&&!/\bON\s+CONFLICT\b/i.test(value))value+=' ON CONFLICT DO NOTHING';if(run&&/^INSERT\s+/i.test(value)&&! /\bRETURNING\b/i.test(value))value+=' RETURNING *';return{sql:value};
}
async function handle(type,payload){
 await ready;if(type==='ping')return{ok:true};if(type==='close'){await client.end();return{ok:true}}
 const translated=translate(payload.sql,{run:type==='run'}),params=translated.params||payload.params||[];if(!translated.sql)return type==='all'?[]:type==='run'?{changes:0,lastInsertRowid:null}:undefined;
 const response=await client.query(translated.sql,params);if(type==='get')return response.rows[0];if(type==='all')return response.rows;if(type==='run')return{changes:response.rowCount||0,lastInsertRowid:response.rows[0]?.id??null};return{changes:response.rowCount||0};
}
port.on('message',async message=>{const view=new Int32Array(message.signal);try{const result=await handle(message.type,message.payload);port.postMessage({id:message.id,result})}catch(error){port.postMessage({id:message.id,error:{message:error.message,code:error.code}})}finally{Atomics.store(view,0,1);Atomics.notify(view,0)}});
