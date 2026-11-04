import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, save, progress } from './common.mjs';
const run=promisify(execFile);
const results=[];
for(let i=1;i<=2;i++){
  const trace=path.join(ROOT,'results',`guide-node-network-${i}.json`);
  const started=performance.now();
  try {
    const result=await run(process.execPath,['--import','./scripts/trace-fetch.mjs','./scripts/guide-node-example.mjs'],{cwd:ROOT,env:{...process.env,VALIDATION_TRACE_FILE:trace},timeout:180000,maxBuffer:1024*1024});
    const output=JSON.parse(result.stdout.trim());
    results.push({run:i,scenario:i===1?'first standard-guide execution':'second fresh-process execution; package model cache retained',durationMs:performance.now()-started,output,stderr:result.stderr,passed:output[0]?.label==='POSITIVE',network:JSON.parse(await readFile(trace,'utf8'))});
  }catch(error){results.push({run:i,passed:false,durationMs:performance.now()-started,error:error.message,stdout:error.stdout,stderr:error.stderr});}
  await save('guide-node-results.json',results);
  await progress('standard-guide-node-run-complete',{run:i,passed:results.at(-1).passed,durationMs:results.at(-1).durationMs});
}
