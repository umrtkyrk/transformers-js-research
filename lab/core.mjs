import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

export const ROOT=fileURLToPath(new URL('./',import.meta.url));
export const WORK=path.resolve(ROOT,'..');
export const STATE=path.resolve(process.env.LAB_STATE_DIR??path.join(ROOT,'.state'));
export const readJSON=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
export async function writeJSON(p,data){await fs.mkdir(path.dirname(p),{recursive:true});const temp=p+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(data,null,2));await fs.rename(temp,p);}
export async function exists(p){try{await fs.access(p);return true;}catch{return false;}}
export function assert(condition,message){if(!condition)throw new Error(message);}
export const hash=value=>createHash('sha256').update(value).digest('hex');
export async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export function safeRepo(id){assert(typeof id==='string'&&/^[\w.-]+\/[\w.-]+$/.test(id)&&!id.includes('..'),'Invalid model repository');return id;}
export function safeVersion(v){assert(typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v),'Only exact stable package versions are accepted');return v;}
export function safeRevision(v){assert(typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),'Model revision must be an immutable commit');return v;}
export function safeRelative(v){assert(typeof v==='string'&&v.length>0&&!/[:\\]/.test(v)&&!v.startsWith('/')&&v.split('/').every(x=>x!=='.'&&x!=='..'&&x.length>0),'Unsafe asset path');return v;}
export async function walk(dir){const files=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.isFile())files.push(path.join(dir,item.name));else if(item.isDirectory())files.push(...await walk(path.join(dir,item.name)));}return files.sort();}
export async function directoryFingerprint(dir){const rows=[];for(const p of await walk(dir))rows.push([path.relative(dir,p).replaceAll('\\','/'),await hashFile(p)]);return hash(JSON.stringify(rows));}
export async function settings(){return {config:await readJSON(process.env.LAB_CONFIG_FILE??path.join(ROOT,'config.json')),local:await readJSON(process.env.LAB_LOCAL_FILE??path.join(ROOT,'local.json'))};}
export async function state(){let value;try{value=await readJSON(path.join(STATE,'state.json'));}catch(e){if(e.code!=='ENOENT')throw e;value={schemaVersion:1,initializedAt:new Date().toISOString(),queue:[],runs:[],candidates:[],lastCheck:null,adoptedVersion:'4.3.2',discoverySeeded:false,discoverySeen:[]};}const schedule=await optionalJSON(path.join(STATE,'schedule.json'));if(schedule)value.schedule=schedule;return value;}
export const saveState=s=>writeJSON(path.join(STATE,'state.json'),s);
export async function withLock(fn){
 await fs.mkdir(STATE,{recursive:true});const lock=path.join(STATE,'runner.lock');
 try{await fs.writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});}catch(e){
  if(e.code!=='EEXIST')throw e;const previous=await readJSON(lock);let alive=true;try{process.kill(previous.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;else throw err;}
  assert(!alive,'Another lab command is running (PID '+previous.pid+').');await fs.unlink(lock);await fs.writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
 }
 try{return await fn();}finally{await fs.unlink(lock).catch(()=>{});}
}
export async function command(executable,args,{cwd,log,timeoutMs=30*60*1000,env={}}={}){
 const output=await fs.open(log,'a');const child=spawn(executable,args,{cwd,windowsHide:true,env:{...process.env,...env},stdio:['ignore',output.fd,output.fd],detached:process.platform!=='win32'});
 let expired=false;const timer=setTimeout(()=>{expired=true;if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else{try{process.kill(-child.pid,'SIGKILL');}catch{}}},timeoutMs);
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(expired)throw new Error('Owned test process exceeded its timeout');assert(code===0,'Command exited with code '+code+'; see its local log');return code;}finally{clearTimeout(timer);await output.close();}
}
export async function getJSON(url,fetcher=fetch){
 const parsed=new URL(url);assert(parsed.protocol==='https:'&&['huggingface.co','registry.npmjs.org'].includes(parsed.hostname),'Unexpected metadata host');
 const response=await fetcher(url,{signal:AbortSignal.timeout(45000),headers:{'User-Agent':'TransformersJS-Research-Lab/1'}});assert(response.ok,'Metadata HTTP '+response.status);const text=await response.text();assert(Buffer.byteLength(text)<8*1024**2,'Metadata exceeds size cap');return JSON.parse(text);
}
export async function modelMetadata(id,revision='main',fetcher=fetch){safeRepo(id);if(revision!=='main')safeRevision(revision);return getJSON('https://huggingface.co/api/models/'+id+'/revision/'+revision+'?blobs=true',fetcher);}
export function assetURL(model,filename){safeRepo(model.id);safeRevision(model.revision);safeRelative(filename);return 'https://huggingface.co/'+model.id+'/resolve/'+model.revision+'/'+filename.split('/').map(encodeURIComponent).join('/');}

export function classifyCandidate(metadata,modelConfig,seedModels){
 if(metadata.private||metadata.gated)return {eligible:false,reason:'Private/gated model requires separate access review.'};
 const task=metadata.pipeline_tag;
 const slot=['feature-extraction','sentence-similarity'].includes(task)?'M1':task==='text-classification'?'M2':task==='automatic-speech-recognition'?'M3':task==='text-to-speech'?'M4':task==='text-generation'?'M5':null;
 if(!slot)return {eligible:false,reason:'No adapter for this task: '+task};
 const adapter=seedModels.find(x=>x.slot===slot);
 if(!adapter.allowedModelTypes.includes(modelConfig.model_type))return {eligible:false,reason:'Model architecture needs a new adapter: '+modelConfig.model_type};
 if(slot==='M1'&&(!Number.isInteger(modelConfig.hidden_size)||modelConfig.max_position_embeddings>512))return {eligible:false,reason:'Embedding dimension/context needs a separate protocol adapter.'};
 if(slot==='M2'){
  const labels=Object.values(modelConfig.id2label??{}).map(x=>String(x).toUpperCase()).sort();
  if(JSON.stringify(labels)!==JSON.stringify(['NEGATIVE','POSITIVE']))return {eligible:false,reason:'Binary POSITIVE/NEGATIVE label mapping is required.'};
 }
 const onnx=(metadata.siblings??[]).filter(x=>x.rfilename?.startsWith('onnx/'));
 const suffix=adapter.dtype==='q8'?'_quantized':adapter.dtype==='q4'?'_q4':'';
 const componentNames=['M3','M4'].includes(slot)?['encoder_model','decoder_model_merged']:['model'];
 const requiredNames=componentNames.map(name=>'onnx/'+name+suffix+'.onnx');
 const weights=requiredNames.map(name=>onnx.find(x=>x.rfilename===name));
 if(weights.some(x=>!x))return {eligible:false,reason:'Required '+adapter.dtype+' ONNX component files are missing; this layout needs a separate adapter.'};
 // External-data models require an explicit file-map adapter instead of guessing chunk names.
 if(onnx.some(x=>weights.some(w=>x.rfilename.startsWith(w.rfilename+'_data'))))return {eligible:false,reason:'External-data ONNX model requires an explicit file-map adapter.'};
 const selected=[...weights,...(metadata.siblings??[]).filter(x=>!x.rfilename.includes('/')&&/\.(json|txt|model)$/.test(x.rfilename))];
 const files=selected.map(x=>({path:safeRelative(x.rfilename),bytes:x.size??x.lfs?.size,sha256:x.lfs?.sha256??x.lfs?.oid}));
 if(files.some(x=>!Number.isSafeInteger(x.bytes)||x.bytes<0))return {eligible:false,reason:'Asset sizes are unavailable; automatic download refused.'};
 return {eligible:true,slot,dtype:adapter.dtype,task:adapter.task,expectedDimensions:slot==='M1'?modelConfig.hidden_size:undefined,files,bytes:files.reduce((s,x)=>s+x.bytes,0)};
}
export function enqueue(s,request){
 const key=hash(JSON.stringify({version:request.version,models:request.models,protocolHash:request.protocolHash,datasetHash:request.datasetHash}));
 if(s.queue.some(x=>x.key===key&&['queued','running'].includes(x.status))||(!request.force&&s.runs.some(x=>x.key===key&&x.status==='completed')))return false;
 s.queue.push({...request,key,queuedAt:new Date().toISOString(),status:'queued'});return true;
}
export async function seedConfigs(){return {base:await readJSON(path.join(ROOT,'seed/model-fixtures.json')),extended:await readJSON(path.join(ROOT,'seed/extended-model-fixtures.json'))};}
export async function identity(){return {protocolHash:hash(JSON.stringify({templates:await directoryFingerprint(path.join(ROOT,'templates')),modelFixture:await hashFile(path.join(ROOT,'seed/model-fixtures.json')),extendedFixture:await hashFile(path.join(ROOT,'seed/extended-model-fixtures.json'))})),datasetHash:await directoryFingerprint(path.join(ROOT,'fixtures'))};}
export async function baseRequest(version,reason='manual baseline'){
 const {config}=await settings();return {version:safeVersion(version),models:structuredClone(config.models),reason,...await identity()};
}
export async function scan(s,{fetcher=fetch,persist=saveState}={}){
 const {config}=await settings();const errors=[];const ident=await identity();let queued=0;
 try{
  const latest=await getJSON('https://registry.npmjs.org/@huggingface%2ftransformers/latest',fetcher);safeVersion(latest.version);
  s.latestPackage=latest.version;
  if(Number(latest.version.split('.')[0])===config.watch.allowedMajor){delete s.packageReview;if(enqueue(s,{version:latest.version,models:structuredClone(config.models),reason:'npm stable release',...ident}))queued++;}
  else s.packageReview='New major release needs protocol compatibility review: '+latest.version;
 }catch(error){errors.push({source:'npm',message:error.message});}
 if(config.watch.models)for(const model of config.models){
  try{
   const info=await modelMetadata(model.id,'main',fetcher);safeRevision(info.sha);
   if(info.sha===model.revision)continue;
   const cfg=await getJSON('https://huggingface.co/'+model.id+'/resolve/'+info.sha+'/config.json',fetcher);
   const classified=classifyCandidate(info,cfg,config.models);
   const candidate={id:model.id,revision:info.sha,detectedAt:new Date().toISOString(),...classified};
   s.candidates=s.candidates.filter(x=>x.id!==candidate.id);s.candidates.push(candidate);
   if(classified.eligible&&classified.slot===model.slot&&classified.bytes<=config.limits.maxNewModelBytes){
    const models=structuredClone(config.models);Object.assign(models.find(x=>x.slot===model.slot),{revision:info.sha,assetFiles:classified.files,expectedDimensions:classified.expectedDimensions});
    if(enqueue(s,{version:s.adoptedVersion,models,reason:'watched model revision: '+model.id,...ident}))queued++;
   }else if(classified.eligible)candidate.reason='Model exceeds configured size cap or changes task.';
  }catch(error){errors.push({source:model.id,message:error.message});}
 }
 for(const author of config.watch.discoveryAuthors){
  try{
   const url='https://huggingface.co/api/models?author='+encodeURIComponent(author)+'&filter=transformers.js&sort=createdAt&direction=-1&limit='+config.watch.discoveryLimit+'&full=true';
   const list=await getJSON(url,fetcher);assert(Array.isArray(list),'Unexpected model-list response');
   for(const item of list){
    const id=safeRepo(item.id??item.modelId);if(s.discoverySeen.includes(id))continue;s.discoverySeen.push(id);
    if(!s.discoverySeeded||config.models.some(x=>x.id===id))continue;
    try{
     const info=await modelMetadata(id,'main',fetcher);safeRevision(info.sha);const cfg=await getJSON('https://huggingface.co/'+id+'/resolve/'+info.sha+'/config.json',fetcher);
     const result=classifyCandidate(info,cfg,config.models),candidate={id,revision:info.sha,detectedAt:new Date().toISOString(),...result};s.candidates.push(candidate);
     if(config.watch.autoEnrollCompatible&&result.eligible&&result.bytes<=config.limits.maxNewModelBytes){const models=structuredClone(config.models);Object.assign(models.find(x=>x.slot===result.slot),{id,revision:info.sha,assetFiles:result.files,expectedDimensions:result.expectedDimensions});if(enqueue(s,{version:s.adoptedVersion,models,reason:'new compatible model: '+id,...ident}))queued++;}
     else if(result.eligible)candidate.reason='Model exceeds configured automatic-download cap.';
    }catch(error){s.discoverySeen=s.discoverySeen.filter(x=>x!==id);s.candidates=s.candidates.filter(x=>x.id!==id);s.candidates.push({id,eligible:false,reason:error.message,detectedAt:new Date().toISOString()});}
   }
  }catch(error){errors.push({source:'discovery:'+author,message:error.message});}
 }
 // A failed first discovery request must be retried as an initial snapshot, not mistaken for new releases.
 if(!errors.some(x=>x.source.startsWith('discovery:')))s.discoverySeeded=true;
 s.lastCheck={at:new Date().toISOString(),status:errors.length?'partial':'completed',errors,queued};await persist(s);return s.lastCheck;
}

export async function ensureRuntime(version,local){
 safeVersion(version);const dir=path.join(STATE,'runtimes',version);await fs.mkdir(dir,{recursive:true});
 const installed=path.join(dir,'node_modules/@huggingface/transformers/package.json');
 const ready=path.join(dir,'ready.json');
 if(!(await exists(installed))||!(await exists(ready))){
  const source=path.join(WORK,'validation-4.3.2');
  if(version==='4.3.2'&&await exists(path.join(source,'node_modules/@huggingface/transformers/package.json'))){
   if(!(await exists(path.join(dir,'node_modules'))))await fs.symlink(path.join(source,'node_modules'),path.join(dir,'node_modules'),'junction');await fs.copyFile(path.join(source,'package-lock.json'),path.join(dir,'package-lock.json'));await fs.copyFile(path.join(source,'package.json'),path.join(dir,'package.json'));
  }else{
   await writeJSON(path.join(dir,'package.json'),{name:version==='4.3.2'?'transformers-js-validation':'isolated-transformers-runtime',version:'1.0.0',private:true,type:'module',dependencies:{'@huggingface/transformers':version}});
   if(version==='4.3.2')await fs.copyFile(path.join(ROOT,'seed/package-lock.json'),path.join(dir,'package-lock.json'));
   await command(process.execPath,[local.npmCli,version==='4.3.2'?'ci':'install','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{cwd:dir,log:path.join(dir,'install.log'),timeoutMs:10*60*1000});
   const lock=await readJSON(path.join(dir,'package-lock.json'));const native=['onnxruntime-node','protobufjs'].filter(name=>lock.packages['node_modules/'+name]);
   if(native.length)await command(process.execPath,[local.npmCli,'rebuild',...native,'--ignore-scripts=false'],{cwd:dir,log:path.join(dir,'install.log')});
  }
  assert((await readJSON(installed)).version===version,'Installed package does not match requested runtime');
  await command(process.execPath,['--input-type=module','-e',"await import('@huggingface/transformers');"],{cwd:dir,log:path.join(dir,'import-check.log'),timeoutMs:60000});
  await writeJSON(ready,{version,verifiedAt:new Date().toISOString(),packageLockSha256:await hashFile(path.join(dir,'package-lock.json'))});
 }
 assert((await readJSON(installed)).version===version,'Installed package does not match the requested version');return dir;
}
export async function materializeAsset(asset,target,budget){
 safeRelative(asset.target);assert(Number.isSafeInteger(asset.bytes)&&asset.bytes>=0,'Unknown asset size');
 const url=new URL(asset.url);assert(url.protocol==='https:'&&url.hostname==='huggingface.co'&&/\/resolve\/[a-f0-9]{40}\//.test(url.pathname),'Asset URL must use a pinned public Hugging Face revision');
 const pool=path.join(STATE,'assets');await fs.mkdir(pool,{recursive:true});const cache=path.join(pool,hash(asset.url));
 let source=cache;
 if(!(await exists(cache))){
  const seed=path.join(WORK,'validation-4.3.2',asset.target);
  const {config}=await settings();const matchingSeed=config.models.some(x=>asset.url.includes('/'+x.id+'/resolve/'+x.revision+'/'))||asset.url.includes('/Xenova/speecht5_hifigan/')||asset.target==='.cache/aux/speaker_embeddings.bin';
  if(matchingSeed&&await exists(seed)&&(await fs.stat(seed)).size===asset.bytes){
   const actual=await hashFile(seed);assert(!asset.sha256||actual===asset.sha256,'Seed asset checksum mismatch');await fs.link(seed,cache).catch(()=>fs.copyFile(seed,cache));
  }else{
   assert(budget.used+asset.bytes<=budget.maximum,'Tick download budget exceeded');budget.used+=asset.bytes;
   let cacheBytes=0;for(const p of await walk(pool))cacheBytes+=(await fs.stat(p)).size;assert(cacheBytes+asset.bytes<=config.limits.maxCacheBytes,'Model cache cap reached; no history was deleted');
   const response=await fetch(asset.url,{signal:AbortSignal.timeout(8*60*1000)});assert(response.ok,'Asset download HTTP '+response.status);
   const partial=cache+'.part';let received=0;
   try{
    const stream=Readable.fromWeb(response.body);stream.on('data',chunk=>{received+=chunk.length;if(received>asset.bytes)stream.destroy(new Error('Asset exceeded its declared size'));});await pipeline(stream,createWriteStream(partial,{flags:'wx'}));assert(received===asset.bytes,'Asset size differs from the pinned manifest');assert(!asset.sha256||await hashFile(partial)===asset.sha256,'Downloaded asset checksum mismatch');await fs.rename(partial,cache);
   }catch(error){await fs.unlink(partial).catch(()=>{});throw error;}
  }
 }
 const actual=await hashFile(source);assert((await fs.stat(source)).size===asset.bytes&&(!asset.sha256||actual===asset.sha256),'Cached asset failed verification');
 await fs.mkdir(path.dirname(target),{recursive:true});await fs.link(source,target).catch(()=>fs.copyFile(source,target));
 return {path:asset.target,bytes:asset.bytes,sha256:actual,url:asset.url};
}
export async function prepareJob(request,jobDir,budget){
 const {config,local}=await settings();const runtime=await ensureRuntime(request.version,local);
 await fs.mkdir(jobDir,{recursive:true});await fs.cp(path.join(ROOT,'templates'),jobDir,{recursive:true});await fs.cp(path.join(ROOT,'fixtures'),path.join(jobDir,'data'),{recursive:true});
 for(const p of await walk(jobDir))if(/\.(mjs|html)$/.test(p)){const t=await fs.readFile(p,'utf8');await fs.writeFile(p,t.replaceAll('__PACKAGE_VERSION__',safeVersion(request.version)));}
 await fs.symlink(path.join(runtime,'node_modules'),path.join(jobDir,'node_modules'),'junction');
 await fs.copyFile(path.join(runtime,'package-lock.json'),path.join(jobDir,'package-lock.json'));
 const {base,extended}=await seedConfigs();base.packageVersion=request.version;extended.packageVersion=request.version;
 const assets=[];
 for(const requested of request.models){
  safeRepo(requested.id);safeRevision(requested.revision);const collection=['M1','M2'].includes(requested.slot)?base.models:extended.models;const fixture=collection.find(x=>x.key===requested.slot);
  Object.assign(fixture,{id:requested.id,revision:requested.revision,dtype:requested.dtype,...(requested.expectedDimensions?{expectedDimensions:requested.expectedDimensions}:{})});
  if(requested.slot==='M1'&&!fixture.expectedDimensions)fixture.expectedDimensions=384;
  if(['M1','M2'].includes(requested.slot)){
   if(requested.assetFiles)fixture.files=requested.assetFiles;
   for(const file of fixture.files)assets.push({...file,target:'.cache/models/'+fixture.id+'/'+file.path,url:assetURL(fixture,file.path)});
  }else{
   const seedId=config.models.find(x=>x.slot===requested.slot).id;
   if(requested.assetFiles){extended.assets=extended.assets.filter(x=>x.repository!==seedId);for(const file of requested.assetFiles)extended.assets.push({modelKey:requested.slot,repository:fixture.id,revision:fixture.revision,filename:file.path,target:'.cache/models/'+fixture.id+'/'+file.path,url:assetURL(fixture,file.path),...file});}
  }
 }
 for(const a of extended.assets)assets.push(a);
 await writeJSON(path.join(jobDir,'config/model-fixtures.json'),base);await writeJSON(path.join(jobDir,'config/extended-model-fixtures.json'),extended);
 const verified=[];for(const asset of assets)verified.push(await materializeAsset(asset,path.join(jobDir,safeRelative(asset.target)),budget));
 await writeJSON(path.join(jobDir,'results/input-artifacts.json'),{files:verified,source:'Pinned assets reused by verified byte content; no previous inference outputs copied.'});
 await writeJSON(path.join(jobDir,'results/job-request.json'),request);
 return {local,verified};
}
export async function optionalJSON(file){try{return await readJSON(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function summarize(jobDir){
 const results=path.join(jobDir,'results');const n=await optionalJSON(path.join(results,'node-final/node-validation.json'));
 const ext={};for(const key of ['M3','M4','M5'])ext[key]=await optionalJSON(path.join(results,'extended/'+key.toLowerCase()+'-validation.json'));
 const b=await optionalJSON(path.join(results,'browser-validation.json'));const suite=await optionalJSON(path.join(results,'full-suite.json'));
 const guide=await optionalJSON(path.join(results,'guide-node-results.json'));const backend=await optionalJSON(path.join(results,'backend-comparison.json'));
 const auxiliaryFailures=[];
 if(!Array.isArray(guide)||guide.length!==2)auxiliaryFailures.push({id:'GUIDE-NODE',error:'Two standard Node guide runs are missing.'});
 else for(const row of guide)if(!row.passed)auxiliaryFailures.push({id:'GUIDE-NODE-'+row.run,error:'The standard Node guide did not pass; see its raw evidence.'});
 if(!backend?.models?.M1||!backend?.models?.M2)auxiliaryFailures.push({id:'BACKEND-COMPARISON',error:'Native/browser comparison was not completed.'});
 const checks=[...(n?.tests??[]),...Object.values(ext).flatMap(x=>x?.tests??[])];
 const complete=suite?.status==='completed'&&!n?.fatalError&&Object.values(ext).every(x=>x?.status==='completed')&&b?.status==='completed'&&checks.length===54&&auxiliaryFailures.length===0;
 const best=n?.phases.batchBenchmark?.summaries?.reduce((a,x)=>!a||x.textsPerSecond>a.textsPerSecond?x:a,null);
 const gen=ext.M5,asr=ext.M3;
 return {complete,technical:{total:checks.length,passed:checks.filter(x=>x.status==='passed').length,failed:checks.filter(x=>x.status==='failed').length,expected:54},
  failures:checks.filter(x=>x.status==='failed').map(x=>({id:x.id,error:x.error})),auxiliaryFailures,
  metrics:{semanticHit1:n?.phases.retrieval?.semantic?.hitAt1,lexicalHit1:n?.phases.retrieval?.lexical?.hitAt1,sentimentAccuracy:n?.phases.sentiment?.accuracy,cleanWer:asr?.observations.clean?.wer,noisyWer:asr?.observations.noise15dB?.wer,generationConstraints:gen?.summary?.automatedConstraintPasses,generationCases:gen?.cases?.length,jsonPasses:gen?.observations.byCategory?.structured_extraction?.passed,jsonCases:gen?.observations.byCategory?.structured_extraction?.cases,ttsClips:ext.M4?.cases?.length,ttsRoundtripWer:(await optionalJSON(path.join(results,'extended/tts-roundtrip.json')))?.summary?.wer,bestBatchTextsPerSecond:best?.textsPerSecond,bestBatchSize:best?.size},
  environment:{node:process.version,cpu:os.cpus()[0]?.model,ramBytes:os.totalmem(),edge:b?.browserVersion,backend:'CPU (4 intra-op / 1 inter-op) + M1/M2 Edge WASM (1 thread)'},suiteStatus:suite?.status??'not-started'};
}
export async function executeRequest(s,request,{budget:sharedBudget}={}){
 const {config}=await settings();assert(os.freemem()>=config.limits.minimumFreeMemoryBytes,'Insufficient available memory; queued job retained');
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+request.key.slice(0,10);const dir=path.join(STATE,'jobs',id);
 const record={id,key:request.key,version:request.version,reason:request.reason,retryOf:request.retryOf,models:request.models,protocolHash:request.protocolHash,datasetHash:request.datasetHash,status:'preparing',startedAt:new Date().toISOString(),execution:config.execution??{kind:'Windows local'}};s.runs.push(record);request.status='running';await saveState(s);
 try{
  const budget=sharedBudget??{used:0,maximum:config.limits.maxDownloadBytesPerTick};const before=budget.used;const prepared=await prepareJob(request,dir,budget);record.downloadBytes=budget.used-before;record.status='running';await saveState(s);
  await command(process.execPath,['scripts/run-full-version-suite.mjs'],{cwd:dir,log:path.join(dir,'runner.log'),timeoutMs:config.limits.jobTimeoutMinutes*60*1000,env:{PLAYWRIGHT_ROOT:prepared.local.playwrightRoot,EDGE_PATH:prepared.local.edgePath}});
  record.summary=await summarize(dir);record.status=record.summary.complete?'completed':'incomplete';delete s.lastRunnerError;
  if(record.status==='completed'&&request.reason==='npm stable release')s.adoptedVersion=request.version;
 }catch(error){record.status='incomplete';record.error=error.message;record.summary=await summarize(dir).catch(()=>null);}
 finally{record.completedAt=new Date().toISOString();request.status=record.status;await saveState(s);await writeJSON(path.join(dir,'run.json'),record);}
 return record;
}
