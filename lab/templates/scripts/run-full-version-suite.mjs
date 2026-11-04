import {spawn} from 'node:child_process';
import {open,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'results');await mkdir(path.join(out,'logs'),{recursive:true});
const installed=JSON.parse(await readFile(path.join(root,'node_modules/@huggingface/transformers/package.json'),'utf8'));
if(installed.version!=='__PACKAGE_VERSION__')throw new Error('Wrong installed package: '+installed.version);
const stages=[
 ['environment','capture-environment.mjs'],['filters','run-filter-tests.mjs'],
 ['node','run-node-validation.mjs','node-final'],
 ['consistency','run-consistency-diagnostics.mjs'],
 ['M3','run-extended-validation.mjs','', 'M3'],
 ['M4','run-extended-validation.mjs','', 'M4'],
 ['M5','run-extended-validation.mjs','', 'M5'],
 ['roundtrip','run-tts-roundtrip.mjs'],
 ['guide-node','run-guide-node.mjs'],
 ['browser','run-browser-validation.mjs'],
 ['backend','run-backend-comparison.mjs']
];
const report={version:installed.version,startedAt:new Date().toISOString(),stages:[],method:'Original runners with exact version metadata/assertions updated only. Stages run sequentially to avoid competing model benchmarks.'};
const save=()=>writeFile(path.join(out,'full-suite.json'),JSON.stringify(report,null,2));
for(const [name,file,id='',arg] of stages){
 const row={name,file,startedAt:new Date().toISOString()};report.stages.push(row);await save();
 console.log(JSON.stringify({event:'stage-start',name,time:row.startedAt}));
 const log=await open(path.join(out,'logs',name+'.log'),'w');
 const child=spawn(process.execPath,['scripts/'+file,...(arg?[arg]:[])],{cwd:root,env:{...process.env,VALIDATION_RUN_ID:id},stdio:['ignore',log.fd,log.fd],windowsHide:true});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});await log.close();
 row.exitCode=code;row.completedAt=new Date().toISOString();await save();
 console.log(JSON.stringify({event:'stage-finished',name,code,time:row.completedAt}));
 if(code!==0){report.status='incomplete';await save();process.exit(1);}
}
report.status='completed';report.completedAt=new Date().toISOString();await save();
console.log(JSON.stringify({event:'suite-completed',stages:report.stages.length}));
