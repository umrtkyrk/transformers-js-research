import path from 'node:path';
import fs from 'node:fs/promises';
import {ROOT,STATE,readJSON,writeJSON,settings,state,saveState,withLock,baseRequest,enqueue,scan,executeRequest,exists,modelMetadata,getJSON,classifyCandidate,safeRepo,safeRevision,command,identity} from './core.mjs';
import {buildPublic,publish} from './report.mjs';
const [action='status',...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
const log=value=>console.log(JSON.stringify(value));
async function recover(s){
 for(const run of s.runs)if(['preparing','running'].includes(run.status)){run.status='interrupted';run.error='Previous process stopped before completion; partial evidence retained.';run.completedAt=new Date().toISOString();}
 for(const item of s.queue)if(item.status==='running')item.status='interrupted';
 await saveState(s);
}
try{
 if(action==='status'){
  const s=await state();log({lastCheck:s.lastCheck,queued:s.queue.filter(x=>x.status==='queued').length,runs:s.runs.map(x=>({id:x.id,status:x.status,version:x.version,technical:x.summary?.technical})),schedule:s.schedule??null,publish:s.lastPublish??null});
 }else if(action==='enable-publishing'){
  await withLock(async()=>{const {config,local}=await settings();await command(process.execPath,[local.vercelCli,'whoami',...(local.vercelGlobalConfig?['--global-config',local.vercelGlobalConfig]:[])],{cwd:ROOT,log:path.join(STATE,'auth-check.log'),timeoutMs:60000});config.publish.enabled=true;config.publish.pendingNativeLogin=false;await writeJSON(path.join(ROOT,'config.json'),config);await buildPublic(await state());log({enabled:true,next:'Run watch or let the daily Windows task run.'});});
 }else if(action==='build'){
  await withLock(async()=>{const s=await state();await buildPublic(s);log({built:true});});
 }else if(action==='publish'){
  await withLock(async()=>{const s=await state();await buildPublic(s);await publish(s);log(s.lastPublish);if(s.lastPublish.status==='failed')process.exitCode=1;});
 }else if(['run','queue','model','check','watch','retry'].includes(action)){
  await withLock(async()=>{
   const s=await state();await recover(s);const {config}=await settings();
   if(action==='check'||action==='watch')log({scan:await scan(s)});
   if(action==='run'||action==='queue'){
    const request=await baseRequest(option('version')??config.seedVersion,action==='queue'?'scheduled end-to-end verification':args.includes('--force')?'manual forced run':'manual baseline');request.force=args.includes('--force');
    if(!enqueue(s,request)&&!s.queue.some(x=>x.status==='queued'&&x.version===request.version)){log({skipped:'Identical protocol, models and package were already tested.'});await buildPublic(s);return;}
    await saveState(s);
   }
   if(action==='model'){
    const id=safeRepo(option('id')),info=await modelMetadata(id,option('revision')??'main');safeRevision(info.sha);
    const cfg=await getJSON('https://huggingface.co/'+id+'/resolve/'+info.sha+'/config.json');const classified=classifyCandidate(info,cfg,config.models);
    if(!classified.eligible||classified.bytes>config.limits.maxNewModelBytes)throw new Error(classified.reason??'Model exceeds automatic size cap');
    const request=await baseRequest(option('version')??s.adoptedVersion,'manual compatible model: '+id);Object.assign(request.models.find(x=>x.slot===classified.slot),{id,revision:info.sha,assetFiles:classified.files,expectedDimensions:classified.expectedDimensions});request.force=args.includes('--force');
    if(!enqueue(s,request)){log({skipped:'This pinned model/version/protocol combination was already tested or queued.'});return;}await saveState(s);
   }
   if(action==='retry'){
    const previous=s.runs.find(x=>x.id===option('run'));if(!previous)throw new Error('Use retry --run <record-id>');
    const request={version:previous.version,models:previous.models,...await identity(),reason:'manual retry',retryOf:previous.id,force:true};enqueue(s,request);await saveState(s);
   }
   if(!['check','queue'].includes(action)){
    const budget={used:0,maximum:config.limits.maxDownloadBytesPerTick};const pending=s.queue.filter(x=>x.status==='queued').slice(0,config.watch.maxJobsPerTick);
    for(const request of pending){log({event:'job-start',version:request.version,reason:request.reason});try{const run=await executeRequest(s,request,{budget});log({event:'job-finished',id:run.id,status:run.status,technical:run.summary?.technical});if(run.status!=='completed')process.exitCode=1;}catch(error){s.lastRunnerError={at:new Date().toISOString(),message:error.message};await saveState(s);log({event:'job-deferred',error:error.message});process.exitCode=1;break;}}
   }
   await buildPublic(s);
   if((action==='watch'&&config.publish.enabled)||args.includes('--publish')){await publish(s);log({publish:s.lastPublish});if(s.lastPublish.status==='failed')process.exitCode=1;}
  });
 }else throw new Error('Commands: status, check, watch, run --version <exact> [--force] [--publish], model --id <owner/model> [--revision <commit>] [--publish], retry --run <id>, build, publish');
}catch(error){console.error(JSON.stringify({status:'failed',message:error.message}));process.exitCode=1;}
