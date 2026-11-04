import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRepo,safeRevision,safeVersion,safeRelative,classifyCandidate,enqueue,scan,settings,getJSON,summarize,readJSON} from './core.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicCopy} from './report.mjs';
const {config}=await settings();
const sha='a'.repeat(40);
test('Inputs cannot escape the model/cache namespace',()=>{
 for(const value of ['../escape','https://example.com','a/b/c','owner/../../x'])assert.throws(()=>safeRepo(value));
 for(const value of ['../x','x/../../y','C:/x','/x','x\\y'])assert.throws(()=>safeRelative(value));
 assert.throws(()=>safeVersion('4.3.2;echo bad'));assert.throws(()=>safeVersion('4.4.0-beta.1'));assert.throws(()=>safeRevision('main'));
 assert.equal(safeRepo('Xenova/model-name'),'Xenova/model-name');assert.equal(safeRevision(sha),sha);
});
const metadata={id:'Xenova/new-embedding',pipeline_tag:'sentence-similarity',sha,siblings:[{rfilename:'onnx/model_quantized.onnx',size:100,lfs:{sha256:'b'.repeat(64)}},{rfilename:'config.json',size:50}]};
test('New embedding model selects a task adapter with its actual dimension',()=>{
 const result=classifyCandidate(metadata,{model_type:'bert',hidden_size:768,max_position_embeddings:512},config.models);
 assert.equal(result.eligible,true);assert.equal(result.slot,'M1');assert.equal(result.expectedDimensions,768);assert.equal(result.bytes,150);
});
test('Unsupported architectures and labels require review',()=>{
 assert.equal(classifyCandidate(metadata,{model_type:'new_unknown'},config.models).eligible,false);
 const result=classifyCandidate({...metadata,pipeline_tag:'text-classification'},{model_type:'bert',id2label:{0:'1 star',1:'5 stars'}},config.models);
 assert.equal(result.eligible,false);assert.match(result.reason,/label/);
 assert.equal(classifyCandidate({...metadata,gated:true},{},config.models).eligible,false);
});
test('Unknown asset sizes and external-data layouts are refused',()=>{
 const cfg={model_type:'bert',hidden_size:384,max_position_embeddings:512};
 assert.equal(classifyCandidate({...metadata,siblings:[{rfilename:'onnx/model_quantized.onnx'}]},cfg,config.models).eligible,false);
 assert.equal(classifyCandidate({...metadata,siblings:[...metadata.siblings,{rfilename:'onnx/model_quantized.onnx_data',size:5}]},cfg,config.models).eligible,false);
});

test('Multi-component models require their complete selected dtype without downloading other variants',()=>{
 const speech={pipeline_tag:'text-to-speech',siblings:[
  {rfilename:'onnx/encoder_model.onnx',size:100},
  {rfilename:'onnx/decoder_model_merged.onnx',size:200},
  {rfilename:'onnx/encoder_model_quantized.onnx',size:20},
  {rfilename:'onnx/decoder_model_merged_fp16.onnx',size:80},
  {rfilename:'config.json',size:10}
 ]};
 const result=classifyCandidate(speech,{model_type:'speecht5'},config.models);
 assert.equal(result.eligible,true);assert.equal(result.bytes,310);
 assert.deepEqual(result.files.filter(x=>x.path.endsWith('.onnx')).map(x=>x.path),['onnx/encoder_model.onnx','onnx/decoder_model_merged.onnx']);
 const partial={...speech,siblings:speech.siblings.filter(x=>x.rfilename!=='onnx/decoder_model_merged.onnx')};
 assert.equal(classifyCandidate(partial,{model_type:'speecht5'},config.models).eligible,false);
 const onlyEncoder={pipeline_tag:'automatic-speech-recognition',siblings:[{rfilename:'onnx/encoder_model_quantized.onnx',size:20}]};
 assert.equal(classifyCandidate(onlyEncoder,{model_type:'whisper'},config.models).eligible,false);
});
test('Queue deduplicates active/completed jobs but retries incomplete ones',()=>{
 const s={queue:[],runs:[]},req={version:'4.3.2',models:[],protocolHash:'p',datasetHash:'d'};
 assert.equal(enqueue(s,req),true);assert.equal(enqueue(s,req),false);
 s.queue[0].status='incomplete';assert.equal(enqueue(s,req),true);
 s.queue.at(-1).status='completed';s.runs.push({key:s.queue[0].key,status:'completed'});assert.equal(enqueue(s,req),false);
 assert.equal(enqueue(s,{...req,force:true}),true);assert.equal(enqueue(s,{...req,datasetHash:'new'}),true);
});
test('Metadata fetch never sends arbitrary-host requests',async()=>{
 let requested=false;await assert.rejects(getJSON('https://evil.example/model',async()=>{requested=true;}));assert.equal(requested,false);
});
function fakeFetch({revision=sha,failDiscovery=false,major='4.3.2'}={}){return async url=>{
 const u=new URL(url);let value;
 if(u.hostname==='registry.npmjs.org')value={version:major};
 else if(u.pathname==='/api/models'){if(failDiscovery)return {ok:false,status:503};value=[];}
 else if(u.pathname.endsWith('/config.json'))value={model_type:'distilbert',id2label:{0:'NEGATIVE',1:'POSITIVE'}};
 else {const m=config.models.find(x=>u.pathname.includes('/'+x.id+'/'));value=m.slot==='M2'?{...metadata,id:m.id,pipeline_tag:'text-classification',sha:revision}:{sha:m.revision};}
 return {ok:true,status:200,text:async()=>JSON.stringify(value)};
};}
test('Mocked upstream update queues a new pinned model and repeats no work',async()=>{
 const s={queue:[],runs:[],candidates:[],adoptedVersion:'4.3.2',discoverySeeded:false,discoverySeen:[]};let saves=0;
 const opts={fetcher:fakeFetch(),persist:async()=>saves++};await scan(s,opts);
 assert.equal(s.queue.length,2);assert.equal(s.queue[1].models.find(x=>x.slot==='M2').revision,sha);assert.equal(s.discoverySeeded,true);
 await scan(s,opts);assert.equal(s.queue.length,2);assert.equal(saves,2);assert.equal(s.lastCheck.errors.length,0);
});
test('First discovery failure remains retryable and future major is visible',async()=>{
 const s={queue:[],runs:[],candidates:[],adoptedVersion:'4.3.2',discoverySeeded:false,discoverySeen:[]};await scan(s,{fetcher:fakeFetch({failDiscovery:true,major:'5.0.0'}),persist:async()=>{}});
 assert.equal(s.discoverySeeded,false);assert.equal(s.lastCheck.status,'partial');assert.match(s.packageReview,/major/);
});
test('Public evidence preserves measurements while removing personal paths/secrets',()=>{
 const result=publicCopy({path:'C:\\Users\\Someone\\project\\result.json',generatedTokenCount:405,api_key:'private',url:'https://example.com/file?Signature=hidden&x=1'});
 assert.equal(result.generatedTokenCount,405);assert.equal(result.api_key,undefined);assert.doesNotMatch(result.path,/Someone/);assert.doesNotMatch(result.url,/hidden/);assert.match(result.url,/x=1/);
});
test('Missing stages never become a completed or healthy zero result',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'transformers-lab-check-'));
 try{const result=await summarize(dir);assert.equal(result.complete,false);assert.equal(result.technical.total,0);assert.equal(result.technical.expected,54);assert.equal(result.metrics.jsonPasses,undefined);}finally{await fs.rmdir(dir);}
});
test('Windows PowerShell UTF8 BOM settings remain readable',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'transformers-lab-bom-'));const file=path.join(dir,'settings.json');
 try{await fs.writeFile(file,'\uFEFF{"enabled":true}');assert.equal((await readJSON(file)).enabled,true);}finally{await fs.unlink(file);await fs.rmdir(dir);}
});
