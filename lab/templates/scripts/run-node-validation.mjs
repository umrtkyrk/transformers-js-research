import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT,RESULTS,config,save,progress,assert,dot,norm,statistics,memory,measured,loadLibrary,loadFixture,validateInputs } from './common.mjs';
import { eligible,rank,lexicalScore,metrics,calibrate,answerability } from './crm-search.mjs';

const report={ startedAt:new Date().toISOString(),settings:{package:'__PACKAGE_VERSION__',backend:'Node native CPU',dtype:'q8',intraOpNumThreads:4,interOpNumThreads:1,network:'blocked during controlled fixture inference',memorySamplingMs:25,predeclaredEmbeddingCosineTolerance:.9999,indexPreparationBatchSize:8,queryEmbeddingBatchSize:1},tests:[],phases:{},networkAttempts:[] };
const originalFetch=globalThis.fetch;
globalThis.fetch=(...args)=>{report.networkAttempts.push(String(args[0]));throw new Error('Network disabled during controlled fixture inference');};
async function test(id,group,fn){const start=performance.now();try{const detail=await fn();report.tests.push({id,group,status:'passed',durationMs:performance.now()-start,detail});}catch(error){report.tests.push({id,group,status:'failed',durationMs:performance.now()-start,error:error.message});}await save('node-validation.json',report);}
async function observations(pipe,key){
 const invalid=[['null',null],['object',{}],['number',42],['empty-array',[]],['mixed-array',['A bright flat in Manchester',null]],['empty-string',''],['whitespace','   ']];
 const results=[];
 for(const [name,value] of invalid){
   const start=performance.now();
   try{const output=await pipe(value,key==='M1'?{pooling:'mean',normalize:true}:undefined);results.push({name,libraryBehavior:'returned-output',durationMs:performance.now()-start,output:key==='M1'?{dims:output.dims,finite:Array.from(output.data).every(Number.isFinite)}:output});}
   catch(error){results.push({name,libraryBehavior:'rejected',durationMs:performance.now()-start,error:error.message});}
 }
 return results;
}
function rowsOf(data){return Array.isArray(data)?data:(data.listings??data.queries??data.cases);}
function maxDifference(a,b){return Math.max(...a.map((value,i)=>Math.abs(value-b[i])));}
function hash(data){return createHash('sha256').update(data).digest('hex');}
let pipe;
try{
 const library=await loadLibrary();
 report.phases.import=library.importMeasurement;
 const lock=JSON.parse(await readFile(path.join(ROOT,'package-lock.json'),'utf8'));
 report.dependencies=Object.fromEntries(['@huggingface/transformers','onnxruntime-node','onnxruntime-web','sharp','@huggingface/tokenizers','@huggingface/jinja'].map(name=>[name,lock.packages[`node_modules/${name}`]?.version]));
 report.packageLockSha256=hash(await readFile(path.join(ROOT,'package-lock.json')));
 report.models=config.models.map(({files,...model})=>model);
 const listingsRaw=await readFile(path.join(ROOT,'data','listings.json'),'utf8');
 const queriesRaw=await readFile(path.join(ROOT,'data','queries.json'),'utf8');
 const sentimentRaw=await readFile(path.join(ROOT,'data','sentiment.json'),'utf8');
 const listings=rowsOf(JSON.parse(listingsRaw)),queries=rowsOf(JSON.parse(queriesRaw)),sentiment=rowsOf(JSON.parse(sentimentRaw));
 report.dataset={listings:listings.length,queries:queries.length,sentiment:sentiment.length,sha256:{listings:hash(listingsRaw),queries:hash(queriesRaw),sentiment:hash(sentimentRaw)}};
 await test('DATA-01','fixture',()=>{assert(new Set(listings.map(x=>x.id)).size===listings.length,'Duplicate listing IDs');assert(new Set(queries.map(x=>x.id)).size===queries.length,'Duplicate query IDs');for(const q of queries){assert(q.expected_no_result===(q.relevant_ids.length===0),`No-result mismatch ${q.id}`);for(const id of q.relevant_ids){const row=listings.find(x=>x.id===id);assert(row&&eligible(row,q),`Relevant ID violates filters: ${q.id}/${id}`);}}return report.dataset;});
 await progress('node-validation-started',report.dataset);
 const loaded=await loadFixture(library.pipeline,'M1');pipe=loaded.value;
 report.phases.embeddingLoad={durationMs:loaded.durationMs,memory:loaded.memory};
 await test('ENV-01','compatibility',()=>{assert(report.dependencies['@huggingface/transformers']==='__PACKAGE_VERSION__','Wrong package');return report.dependencies;});
 const probeTexts=['A bright two-bedroom flat in Manchester','A detached house with a garden in Bristol'];
 const probe=await measured(()=>pipe(probeTexts,{pooling:'mean',normalize:true}));
 const vectors=probe.value.tolist();
 await save('embedding-reference.json',{texts:probeTexts,vectors,model:config.models[0]});
 await test('EMB-01','compatibility',()=>{assert(probe.value.dims[0]===2&&probe.value.dims[1]===config.models[0].expectedDimensions,'Unexpected embedding shape');assert(vectors.flat().every(Number.isFinite),'Non-finite values');return {dims:probe.value.dims,durationMs:probe.durationMs,memory:probe.memory};});
 await test('EMB-02','compatibility',()=>{const norms=vectors.map(norm);assert(norms.every(n=>Math.abs(n-1)<2e-4),'Norm outside tolerance');return {norms,tolerance:2e-4};});
 await test('EMB-03','consistency',async()=>{const single=(await pipe(probeTexts[0],{pooling:'mean',normalize:true})).tolist()[0];const cosine=dot(single,vectors[0]);assert(cosine>=.9999,`Single/batch cosine drift: ${cosine}; required >=0.9999`);return {cosine,maxAbsoluteDifference:maxDifference(single,vectors[0]),minimumCosine:.9999};});
 await test('EMB-04','consistency',async()=>{const reversed=(await pipe([...probeTexts].reverse(),{pooling:'mean',normalize:true})).tolist();const cosines=[dot(vectors[0],reversed[1]),dot(vectors[1],reversed[0])];assert(cosines.every(n=>n>=.9999),'Input order mismatch');return {cosines};});
 const longBase='A spacious flat with bright rooms and a modern kitchen. '.repeat(150);
 await test('LEN-01','tokenization',async()=>{const raw=pipe.tokenizer(longBase,{padding:true,truncation:false});const truncated=pipe.tokenizer(longBase,{padding:true,truncation:true});const detail={tokenizerModelMaxLength:pipe.tokenizer.model_max_length,rawDims:raw.input_ids.dims,truncatedDims:truncated.input_ids.dims,warning:'The upstream SentenceTransformer 128-token setting is not assumed to equal this JavaScript tokenizer limit.'};assert(raw.input_ids.dims.at(-1)>truncated.input_ids.dims.at(-1),'Long text was not truncated');report.phases.tokenization=detail;return detail;});
 await test('LEN-02','tokenization',async()=>{const a=pipe.tokenizer(longBase,{padding:true,truncation:true});const b=pipe.tokenizer(longBase+' A private garden is essential.',{padding:true,truncation:true});const same=Array.from(a.input_ids.data).every((v,i)=>v===b.input_ids.data[i]);assert(same,'Expected tail beyond truncation boundary to be ignored');const emb=(await pipe([longBase,longBase+' A private garden is essential.'],{pooling:'mean',normalize:true})).tolist();return {identicalTruncatedTokenIds:same,embeddingCosine:dot(emb[0],emb[1]),finding:'A requirement beyond the truncation boundary never reaches the model.'};});
 await test('LEN-03','tokenization',()=>{const tokenized=pipe.tokenizer([probeTexts[0],longBase],{padding:true,truncation:true});const dims=tokenized.input_ids.dims;const mask=Array.from(tokenized.attention_mask.data,Number);const sums=Array.from({length:dims[0]},(_,i)=>mask.slice(i*dims[1],(i+1)*dims[1]).reduce((a,b)=>a+b,0));return {paddedDims:dims,realTokenCounts:sums,paddingTokens:dims[0]*dims[1]-sums.reduce((a,b)=>a+b,0)};});
 await test('LEN-04','consistency',async()=>{const mixed=(await pipe([probeTexts[0],longBase],{pooling:'mean',normalize:true})).tolist()[0];const cosine=dot(vectors[0],mixed);assert(cosine>=.9999,`Padding changed short input embedding: ${cosine}; required >=0.9999`);return {cosine,maxAbsoluteDifference:maxDifference(vectors[0],mixed)};});
 const libraryInputObservations=await observations(pipe,'M1');report.phases.embeddingInvalidInputs=libraryInputObservations;
 for(const [name,input] of [['null',null],['object',{}],['empty-array',[]],['mixed-array',['valid',null]],['blank','  '],['oversized-batch',Array(33).fill('valid')]])await test(`GUARD-${name}`,'application-input-guard',()=>{let rejected=false;try{validateInputs(input);}catch{rejected=true;}assert(rejected,'Application guard accepted invalid input');return {rejected:true,layer:'example application, not the library'};});
 await test('API-01','failure-behavior',async()=>{let error;try{await library.pipeline('not-a-supported-task','missing-model',{local_files_only:true});}catch(e){error=e.message;}assert(error,'Unsupported task did not reject');return {error};});
 await test('API-02','failure-behavior',async()=>{let error;try{await library.pipeline('feature-extraction','validation/nonexistent-model',{local_files_only:true,device:'cpu',dtype:'q8'});}catch(e){error=e.message;}assert(error,'Missing local model did not reject');return {error};});
 await test('API-03','failure-behavior',async()=>{let error;try{const x=await library.pipeline('feature-extraction',config.models[0].id,{local_files_only:true,device:'cpu',dtype:'fp32'});await x.dispose();}catch(e){error=e.message;}assert(error,'Unavailable local fp32 variant did not reject');return {error};});
 await test('API-04','streamer-guard',()=>{const streamer=new library.TextStreamer(pipe.tokenizer,{skip_prompt:true});let error;try{streamer.put([[1n],[2n]]);}catch(e){error=e.message;}assert(error?.includes('batch size of 1'),'Unexpected streamer batch guard');return {error,generationModelExecuted:false};});
 await progress('compatibility-and-edge-cases-complete',{tests:report.tests.length});

 const listingVectors=[];const queryVectors=[];
 const prep=await measured(async()=>{for(let i=0;i<listings.length;i+=8)listingVectors.push(...(await pipe(listings.slice(i,i+8).map(x=>x.text),{pooling:'mean',normalize:true})).tolist());for(const query of queries)queryVectors.push((await pipe(query.query,{pooling:'mean',normalize:true})).tolist()[0]);});
 report.phases.retrievalPreparation={durationMs:prep.durationMs,memory:prep.memory};
 const index=new Map(listings.map((record,i)=>[record.id,listingVectors[i]]));
 const searchRows=queries.map((q,i)=>({...q,ranking:rank(listings,q,r=>dot(queryVectors[i],index.get(r.id))),lexicalRanking:rank(listings,q,r=>lexicalScore(q.query,r.text))}));
 const dev=searchRows.filter(x=>x.split==='development'),evaluation=searchRows.filter(x=>x.split==='evaluation');
 const lexicalRows=rows=>rows.map(x=>({...x,ranking:x.lexicalRanking}));
 const semanticThreshold=calibrate(dev),lexicalThreshold=calibrate(lexicalRows(dev));
 const categories=[...new Set(evaluation.map(x=>x.category))];
 report.phases.retrieval={semantic:metrics(evaluation),lexical:metrics(lexicalRows(evaluation)),semanticCalibration:semanticThreshold,lexicalCalibration:lexicalThreshold,semanticAnswerability:answerability(evaluation,semanticThreshold.threshold),lexicalAnswerability:answerability(lexicalRows(evaluation),lexicalThreshold.threshold),byCategory:Object.fromEntries(categories.map(category=>[category,{semantic:metrics(evaluation.filter(x=>x.category===category)),lexical:metrics(lexicalRows(evaluation.filter(x=>x.category===category)))}])),candidateCounts:evaluation.map(x=>({id:x.id,eligible:x.ranking.length})),note:'Quality is descriptive on this synthetic fixture. No production acceptance threshold was supplied. Ground truth labels and filters are never sent to the embedding model.'};
 report.phases.retrieval.multiCandidateEvaluation={semantic:metrics(evaluation.filter(x=>x.ranking.length>1)),lexical:metrics(lexicalRows(evaluation.filter(x=>x.ranking.length>1)))};
 await save('retrieval-results.json',{summary:report.phases.retrieval,queries:searchRows.map(x=>({...x,ranking:x.ranking.slice(0,5),lexicalRanking:x.lexicalRanking.slice(0,5)}))});
 await test('CRM-01','application-filters',()=>{let inspected=0;for(const q of searchRows)for(const hit of q.ranking){assert(eligible(listings.find(x=>x.id===hit.id),q),'Filter violation');inspected++;}return {inspectedResults:inspected,violations:0,layer:'fixture application'};});
 await test('CRM-02','application-permissions',()=>{const q={allowed_office:'alpha',filters:{active:true}};const clone={...listings.find(x=>x.office==='alpha'&&x.active),id:'unauthorized-identical-copy',office:'beta'};assert(!eligible(clone,q),'Identical unauthorized text leaked');return {identicalTextOtherOfficeExcluded:true};});
 await test('CRM-03','application-permissions',()=>{assert(listings.every(x=>!eligible(x,{allowed_office:'unknown',filters:{}})),'Unknown scope not denied');return {emptyScopeDenied:true};});
 await test('CRM-04','application-updates',()=>{const record=listings.find(x=>x.office==='alpha'&&x.active);assert(!eligible({...record,active:false},{allowed_office:'alpha',filters:{active:true}}),'Inactive record remained eligible');const current=new Map(listings.map(x=>[x.id,x]));current.delete(record.id);assert(!current.has(record.id),'Deleted record remained in active record map');return {inactiveAndDeletedRecordsExcluded:true,note:'Application fixture logic, not a production authorization audit or external CRM integration.'};});
 await progress('retrieval-evaluation-complete',{semantic:report.phases.retrieval.semantic,lexical:report.phases.retrieval.lexical});

 const pool=Array.from({length:64},(_,i)=>listings[i%listings.length].text);
 const sizes=[1,4,8,16,32],rawTimings=[];
 for(let i=0;i<3;i++)await pipe(pool.slice(0,8),{pooling:'mean',normalize:true});
 for(let round=0;round<10;round++){
   const order=round%2===0?[1,8,32,4,16]:[16,4,1,32,8];
   for(const size of order){
     if(memory().availableSystemBytes<600*1024*1024){rawTimings.push({round,size,skipped:'available system memory below 600 MiB'});continue;}
     const run=await measured(async()=>{let processed=0;const times=[];for(let i=0;i<pool.length;i+=size){const start=performance.now();const out=await pipe(pool.slice(i,i+size),{pooling:'mean',normalize:true});assert(out.dims[0]===Math.min(size,pool.length-i),'Batch output count mismatch');processed+=out.dims[0];times.push(performance.now()-start);}return {processed,batchTimesMs:times};});
     rawTimings.push({round,size,durationMs:run.durationMs,...run.value,memory:run.memory});
   }
   await progress('batch-benchmark-round-complete',{round:round+1,totalRounds:10});
   await save('batch-timings.json',rawTimings);
 }
 report.phases.batchBenchmark={corpusSize:64,rounds:10,warmupCalls:3,summaries:sizes.map(size=>{const rows=rawTimings.filter(r=>r.size===size&&!r.skipped),times=rows.flatMap(r=>r.batchTimesMs);return {size,completedRounds:rows.length,batchLatencyMs:statistics(times),corpusRoundMs:statistics(rows.map(r=>r.durationMs)),textsPerSecond:rows.reduce((s,r)=>s+r.processed,0)/rows.reduce((s,r)=>s+r.durationMs/1000,0),sampledMaxProcessRssBytes:Math.max(...rows.map(r=>r.memory.sampledMaxRssBytes))};}),note:'Native CPU, four intra-op threads; repeated synthetic texts. Amortized throughput is not interactive user latency.'};
 const scaling=[];
 for(const count of [256,1024,4096]){
   if(memory().availableSystemBytes<600*1024*1024){scaling.push({count,skipped:'available memory guard'});continue;}
   const run=await measured(async()=>{let processed=0;for(let i=0;i<count;i+=16){const texts=Array.from({length:Math.min(16,count-i)},(_,j)=>pool[(i+j)%pool.length]);const output=await pipe(texts,{pooling:'mean',normalize:true});processed+=output.dims[0];}return processed;});
   scaling.push({count,processed:run.value,batchSize:16,durationMs:run.durationMs,textsPerSecond:run.value/(run.durationMs/1000),memory:run.memory});
   await save('scaling-results.json',scaling);await progress('scaling-run-complete',{count,durationMs:run.durationMs});
 }
 report.phases.scaling=scaling;
 await test('JOB-01','application-resume',async()=>{
   const records=listings.slice(0,12),filename=path.join(RESULTS,'job-checkpoint.json');
   await writeFile(filename,JSON.stringify({completed:{}}));
   let injected=false;
   async function runJob(shouldFail){const checkpoint=JSON.parse(await readFile(filename,'utf8'));for(let i=0;i<records.length;i+=4){const pending=records.slice(i,i+4).filter(x=>!checkpoint.completed[x.id]);if(!pending.length)continue;const vectors=(await pipe(pending.map(x=>x.text),{pooling:'mean',normalize:true})).tolist();pending.forEach((r,j)=>{checkpoint.completed[r.id]={dimensions:vectors[j].length,vectorSha256:hash(JSON.stringify(vectors[j]))};});await writeFile(filename,JSON.stringify(checkpoint,null,2));if(shouldFail&&!injected){injected=true;throw new Error('Injected interruption after a persisted batch');}}return checkpoint;}
   try{await runJob(true);}catch(e){assert(e.message.startsWith('Injected'),'Unexpected job error');}
   const resumed=await runJob(false),again=await runJob(false);assert(Object.keys(resumed.completed).length===12,'Missing resumed records');assert(Object.keys(again.completed).length===12,'Duplicate records on repeated job');return {records:12,firstRunInterrupted:true,completedAfterResume:12,completedAfterRepeatedRun:12,note:'Persisted toy checkpoint and retry in one process; no external CRM transaction or operating-system crash was tested.'};
 });
 await save('node-validation.json',report);
 await pipe.dispose();pipe=null;
 await progress('embedding-phases-complete');

 const classificationLoad=await loadFixture(library.pipeline,'M2');pipe=classificationLoad.value;
 report.phases.classificationLoad={durationMs:classificationLoad.durationMs,memory:classificationLoad.memory};
 const sentimentOutputs=[];for(let i=0;i<sentiment.length;i+=8)sentimentOutputs.push(...await pipe(sentiment.slice(i,i+8).map(x=>x.text)));
 const sentimentRows=sentiment.map((item,i)=>({...item,predicted:sentimentOutputs[i]}));
 const labeled=sentimentRows.filter(x=>x.expected_label!=null);
 const labels=['POSITIVE','NEGATIVE'];
 const perClass=Object.fromEntries(labels.map(label=>{const tp=labeled.filter(x=>x.expected_label===label&&x.predicted.label===label).length,fp=labeled.filter(x=>x.expected_label!==label&&x.predicted.label===label).length,fn=labeled.filter(x=>x.expected_label===label&&x.predicted.label!==label).length;return [label,{tp,fp,fn,precision:tp/(tp+fp||1),recall:tp/(tp+fn||1)}];}));
 report.phases.sentiment={labeled:labeled.length,ambiguousExcluded:sentimentRows.length-labeled.length,correct:labeled.filter(x=>x.expected_label===x.predicted.label).length,accuracy:labeled.filter(x=>x.expected_label===x.predicted.label).length/labeled.length,perClass,byCategory:Object.fromEntries([...new Set(labeled.map(x=>x.category))].map(category=>{const a=labeled.filter(x=>x.category===category);return [category,{count:a.length,correct:a.filter(x=>x.expected_label===x.predicted.label).length}];}))};
 await save('sentiment-results.json',{summary:report.phases.sentiment,cases:sentimentRows});
 await test('CLS-01','compatibility',()=>{assert(sentimentOutputs.length===sentiment.length,'Classification count mismatch');assert(sentimentOutputs.every(x=>labels.includes(x.label)&&Number.isFinite(x.score)),'Invalid classification output');return {count:sentimentOutputs.length};});
 await test('CLS-02','consistency',async()=>{const subset=sentiment.slice(0,8);const batched=await pipe(subset.map(x=>x.text));let maxScoreDifference=0;for(let i=0;i<subset.length;i++){const single=(await pipe(subset[i].text))[0];assert(single.label===batched[i].label,'Single/batch label changed');maxScoreDifference=Math.max(maxScoreDifference,Math.abs(single.score-batched[i].score));}assert(maxScoreDifference<.001,'Classification score drift');return {cases:subset.length,maxScoreDifference,tolerance:.001};});
 report.phases.classificationInvalidInputs=await observations(pipe,'M2');
 await pipe.dispose();pipe=null;
 await test('ENV-02','offline-fixture',()=>{assert(report.networkAttempts.length===0,'Unexpected network access attempted');return {networkAttempts:0,modelSources:'SHA256-verified immutable local fixtures'};});
 report.completedAt=new Date().toISOString();report.summary={passed:report.tests.filter(x=>x.status==='passed').length,failed:report.tests.filter(x=>x.status==='failed').length,tests:report.tests.length};
 await save('node-validation.json',report);await progress('node-validation-complete',report.summary);
}catch(error){report.fatalError={message:error.message,stack:error.stack};report.completedAt=new Date().toISOString();await save('node-validation.json',report);console.error(error);process.exitCode=1;}
finally{if(pipe)await pipe.dispose();globalThis.fetch=originalFetch;}
