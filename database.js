const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Worker,MessageChannel,receiveMessageOnPort}=require('node:worker_threads');

class SQLiteDatabase extends DatabaseSync{constructor(file){super(file);this.dialect='sqlite'}}

class PostgreSQLDatabase{
 constructor(connectionString){
  this.dialect='postgres';this.sequence=0;const channel=new MessageChannel();this.port=channel.port1;
  this.worker=new Worker(path.join(__dirname,'postgres-worker.js'),{workerData:{connectionString,port:channel.port2,reset:process.env.NODE_ENV==='test'&&process.env.DATABASE_RESET_FOR_TESTS==='true'},transferList:[channel.port2]});
  this.call('ping',{});
 }
 call(type,payload){
  const signal=new SharedArrayBuffer(4),view=new Int32Array(signal),id=++this.sequence;this.port.postMessage({id,type,payload,signal});
  const status=Atomics.wait(view,0,0,30000);if(status==='timed-out')throw new Error(`PostgreSQL ${type} timed out`);
  const packet=receiveMessageOnPort(this.port)?.message;if(!packet||packet.id!==id)throw new Error('PostgreSQL worker returned an invalid response');if(packet.error){const error=new Error(packet.error.message);error.code=packet.error.code;throw error}return packet.result;
 }
 exec(sql){return this.call('exec',{sql})}
 prepare(sql){return{get:(...params)=>this.call('get',{sql,params}),all:(...params)=>this.call('all',{sql,params}),run:(...params)=>this.call('run',{sql,params})}}
 close(){try{this.call('close',{})}finally{this.port.close();this.worker.terminate()}}
}

function createDatabase({file,connectionString=process.env.DATABASE_URL}={}){return connectionString?new PostgreSQLDatabase(connectionString):new SQLiteDatabase(file)}

module.exports={createDatabase};
