const fs=require('node:fs');
const path=require('node:path');
const {decryptBackup}=require('../operations');

const [input,output]=process.argv.slice(2);
if(!input||!output){console.error('Usage: npm run restore-backup -- <encrypted-backup> <restored.sqlite>');process.exit(2)}
const source=path.resolve(input),target=path.resolve(output);
if(source===target){console.error('Input and output paths must be different');process.exit(2)}
try{fs.writeFileSync(target,decryptBackup(fs.readFileSync(source)),{flag:'wx',mode:0o600});console.log(`Restored backup to ${target}`)}catch(error){console.error(`Restore failed: ${error.message}`);process.exit(1)}
