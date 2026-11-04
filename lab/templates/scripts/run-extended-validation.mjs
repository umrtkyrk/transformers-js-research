import { readFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT,OUT,config,hash,loadJSON,saveJSON,normalize,speechScore,readWave,writeWave,audioStats,noisy,generationScore } from './extended-utils.mjs';
import { measured,statistics } from './common.mjs';

const key=process.argv[2];
if(!['M3','M4','M5'].includes(key))throw new Error('Provide M3, M4 or M5');
const fixture=config.models.find(x=>x.key===key);
const report={model:fixture,startedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,architecture:process.arch,cpu:os.cpus()[0]?.model,freeMemoryBytesAtStart:os.freemem()},settings:{package:'__PACKAGE_VERSION__',backend:'Node native CPU',intraOpNumThreads:4,interOpNumThreads:1,network:'disabled during controlled inference',memory:'Whole-process RSS sampled25ms; short native peaks may be missed.'},tests:[],cases:[],observations:{},networkAttempts:[]};
let pipe,vocoder;
const resultFile=key.toLowerCase()+'-validation.json';
const flush=()=>saveJSON(resultFile,report);
async function test(id,purpose,fn){const start=performance.now();try{const detail=await fn();report.tests.push({id,purpose,status:'passed',durationMs:performance.now()-start,detail});}catch(error){report.tests.push({id,purpose,status:'failed',durationMs:performance.now()-start,error:error.message});}await flush();}
function require(condition,message){if(!condition)throw new Error(message);}
function rejectNetwork(...args){report.networkAttempts.push(String(args[0]));throw new Error('Network disabled during extended validation');}
globalThis.fetch=rejectNetwork;
const imported=await measured(()=>import('@huggingface/transformers'));
const lib=imported.value;
lib.env.allowLocalModels=true;lib.env.allowRemoteModels=false;lib.env.localModelPath=path.join(ROOT,'.cache/models')+path.sep;lib.env.useFSCache=false;lib.env.useBrowserCache=false;
const options={revision:fixture.revision,device:'cpu',dtype:fixture.dtype,local_files_only:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}};
const trace=(event,detail={})=>console.log(JSON.stringify({event,model:key,...detail}));
try {
 report.import={durationMs:imported.durationMs,memory:imported.memory};
 const lock=await readFile(path.join(ROOT,'package-lock.json'));report.packageLockSha256=hash(lock);
 report.dependencies=Object.fromEntries(['@huggingface/transformers','onnxruntime-node'].map(name=>[name,JSON.parse(lock).packages['node_modules/'+name].version]));
 await test(key+'-VERSION','Exact installed package',()=>{require(report.dependencies['@huggingface/transformers']==='__PACKAGE_VERSION__','Wrong version');return report.dependencies;});
 if(key==='M4'){
  const v=await measured(()=>lib.AutoModel.from_pretrained(config.vocoder.id,{...options,revision:config.vocoder.revision,dtype:'fp32'}));vocoder=v.value;report.vocoderLoad={durationMs:v.durationMs,memory:v.memory};
 }
 trace('model-load-start');
 const loaded=await measured(()=>lib.pipeline(fixture.task,fixture.id,{...options,...(vocoder?{vocoder}:{})}));pipe=loaded.value;report.load={durationMs:loaded.durationMs,memory:loaded.memory};
 await test(key+'-LOAD','Pinned model loads on native CPU',()=>({revision:fixture.revision,dtype:fixture.dtype,loadMs:loaded.durationMs}));
 trace('model-load-complete',{loadMs:loaded.durationMs});
 if(key==='M3'){
  const data=await loadJSON('data/speech-fixtures.json');report.dataset={source:data.source,fixtureSha256:hash(await readFile(path.join(ROOT,'data/speech-fixtures.json'))),normalization:data.notes};
  const cases=[];const clean=[];
  for(const item of data.cases){const wave=await readWave(path.join(ROOT,item.wav));require(wave.sampleRate===16000,'Wrong fixture sample rate');clean.push({...item,...wave});cases.push({...item,audio:wave.audio,condition:'clean',sha256:wave.sha256});const noise=noisy(wave.audio,data.noise.snrDb,data.noise.seed+cases.length);const filename='data/audio/'+item.id+'-noisy.wav';const info=await writeWave(path.join(ROOT,filename),noise);cases.push({...item,id:item.id+'-N',wav:filename,audio:noise,condition:'noise15dB',sha256:info.sha256});}
  for(const seconds of [1,3]){const filename='data/audio/silence-'+seconds+'.wav',audio=new Float32Array(16000*seconds),info=await writeWave(path.join(ROOT,filename),audio);cases.push({id:'SILENCE-'+seconds,text:'',required_phrases:[],wav:filename,audio,condition:'silence',sha256:info.sha256});}
  const joined=new Float32Array(clean.reduce((sum,x)=>sum+x.audio.length,0));let offset=0;for(const x of clean){joined.set(x.audio,offset);offset+=x.audio.length;}const longFile='data/audio/long-joined.wav',longInfo=await writeWave(path.join(ROOT,longFile),joined);cases.push({id:'LONG-01',text:clean.map(x=>x.text).join(' '),required_phrases:[],wav:longFile,audio:joined,condition:'long-chunked',sha256:longInfo.sha256});
  report.dataset.generatedCases=cases.map(({audio,...item})=>({...item,durationSeconds:audio.length/16000}));await flush();
  for(const item of cases){const params={language:'english',task:'transcribe',max_new_tokens:128,do_sample:false,...(item.condition==='long-chunked'?{chunk_length_s:15,stride_length_s:3}:{})};const run=await measured(()=>pipe(item.audio,params));const text=run.value.text;report.cases.push({id:item.id,condition:item.condition,wav:item.wav,reference:item.text,prediction:text,durationSeconds:item.audio.length/16000,durationMs:run.durationMs,realTimeFactor:run.durationMs/(item.audio.length/16),memory:run.memory,sha256:item.sha256,score:speechScore(item.text,text,item.required_phrases)});await flush();trace('case-complete',{id:item.id,durationMs:run.durationMs,prediction:text});}
  for(const condition of ['clean','noise15dB','long-chunked']){const rows=report.cases.filter(x=>x.condition===condition);report.observations[condition]={cases:rows.length,referenceWords:rows.reduce((s,x)=>s+x.score.referenceWords,0),wordErrors:rows.reduce((s,x)=>s+x.score.wordErrors,0),wer:rows.reduce((s,x)=>s+x.score.wordErrors,0)/rows.reduce((s,x)=>s+x.score.referenceWords,0),latencyMs:statistics(rows.map(x=>x.durationMs)),medianRealTimeFactor:statistics(rows.map(x=>x.realTimeFactor)).median};}
  await test('ASR-OUTPUT','All23 inference cases return a string',()=>{require(report.cases.length===23&&report.cases.every(x=>typeof x.prediction==='string'),'Missing outputs');return {cases:report.cases.length};});
  await test('ASR-SILENCE','Silence produces no transcribed speech',()=>{const rows=report.cases.filter(x=>x.condition==='silence');require(rows.every(x=>normalize(x.prediction)===''),'Speech hallucinated on silence: '+JSON.stringify(rows.map(x=>x.prediction)));return {cases:rows.length};});
  await test('ASR-BATCH','Two audio inputs preserve order and text',async()=>{const result=await measured(()=>pipe(clean.slice(0,2).map(x=>x.audio),{language:'english',task:'transcribe',max_new_tokens:128,do_sample:false}));require(Array.isArray(result.value)&&result.value.length===2,'Expected two outputs');const single=report.cases.filter(x=>x.condition==='clean').slice(0,2).map(x=>normalize(x.prediction)),batch=result.value.map(x=>normalize(x.text));require(batch.every((x,i)=>x===single[i]),'Single/batch transcripts differ');return {outputs:result.value,durationMs:result.durationMs};});
  await test('ASR-TIMESTAMPS','Timestamp mode returns bounded timestamp chunks',async()=>{const result=await pipe(clean[0].audio,{language:'english',task:'transcribe',return_timestamps:true,max_new_tokens:128,do_sample:false});require(Array.isArray(result.chunks)&&result.chunks.length>0,'No timestamp chunks');require(result.chunks.every(x=>Array.isArray(x.timestamp)&&x.timestamp[0]>=0&&(x.timestamp[1]===null||x.timestamp[1]>=x.timestamp[0])),'Invalid timestamps');return result;});
  const warm=[];for(let i=0;i<3;i++){const result=await measured(()=>pipe(clean[0].audio,{language:'english',task:'transcribe',max_new_tokens:128,do_sample:false}));warm.push(result.durationMs);}report.observations.warm=statistics(warm);
  await test('ASR-NODE-WAV-PATH','Node path loading fails clearly without AudioContext',async()=>{let message;try{await pipe(path.join(ROOT,clean[0].wav),{max_new_tokens:8});}catch(e){message=e.message;}require(message?.includes('AudioContext'),'Expected documented Node audio decoding limitation');return {error:message,workaround:'Decode WAV to Float32Array before pipeline'};});
 }
 if(key==='M4'){
  const data=await loadJSON('data/tts-fixtures.json'),buffer=await readFile(path.join(ROOT,config.speakerEmbedding.target));const speaker=Float32Array.from({length:buffer.length/4},(_,i)=>buffer.readFloatLE(i*4));require(speaker.length===512,'Expected512-dimensional speaker embedding');
  report.dataset={fixtureSha256:hash(await readFile(path.join(ROOT,'data/tts-fixtures.json'))),speakerEmbeddingSha256:hash(buffer),speakerEmbeddingDimensions:speaker.length,notes:data.notes};await mkdir(path.join(OUT,'tts-audio'),{recursive:true});
  const defaultPipe=pipe;
  await test('TTS-DEFAULT-PIPELINE','Unmodified convenience pipeline produces non-empty audio',async()=>{const output=await defaultPipe('A flat in London.',{speaker_embeddings:speaker});require(output.audio?.length>0,'Empty audio output');return {samples:output.audio.length};});
  const processor=await lib.AutoProcessor.from_pretrained(fixture.id,options);
  const explicitPipe=new lib.TextToAudioPipeline({task:'text-to-audio',model:defaultPipe.model,tokenizer:defaultPipe.tokenizer,processor,vocoder});
  await test('TTS-EXPLICIT-PIPELINE','Explicit processor and vocoder pipeline produces non-empty audio',async()=>{const output=await explicitPipe('A flat in London.',{speaker_embeddings:speaker});require(output.audio?.length>0,'Empty audio output');return {samples:output.audio.length};});
  report.observations.inferenceRoute='Direct SpeechT5ForTextToSpeech.generate_speech with tokenizer, speaker tensor and explicit HiFiGAN; no installed library modifications. Default and explicit pipeline findings retained as separate tests.';
  report.observations.pipelineComponents={defaultHasProcessor:!!defaultPipe.processor,defaultHasVocoder:!!defaultPipe.vocoder};
  const direct=async(text,{speaker_embeddings}={})=>{const {input_ids}=defaultPipe.tokenizer(text,{padding:true,truncation:true});const embeddings=speaker_embeddings instanceof lib.Tensor?speaker_embeddings:new lib.Tensor('float32',speaker_embeddings,[1,speaker_embeddings?.length]);const output=await defaultPipe.model.generate_speech(input_ids,embeddings,{vocoder});return {audio:output.waveform.data,sampling_rate:processor.feature_extractor.config.sampling_rate,waveformDimensions:output.waveform.dims};};
  direct.dispose=()=>defaultPipe.dispose();pipe=direct;

  for(const item of data.cases){const run=await measured(()=>pipe(item.text,{speaker_embeddings:speaker})),audio=run.value.audio,stats=audioStats(audio,run.value.sampling_rate),filename='results/extended/tts-audio/'+item.id+'.wav',file=await writeWave(path.join(ROOT,filename),audio,run.value.sampling_rate);report.cases.push({...item,stats,durationMs:run.durationMs,realTimeFactor:run.durationMs/(stats.durationSeconds*1000),memory:run.memory,wav:filename,file});await flush();trace('case-complete',{id:item.id,durationMs:run.durationMs,audioSeconds:stats.durationSeconds});}
  await test('TTS-WAVEFORM','Eight outputs are finite non-silent16000Hz audio',()=>{require(report.cases.length===8&&report.cases.every(x=>x.stats.finite&&x.stats.sampleRate===16000&&x.stats.durationSeconds>0&&x.stats.rms>1e-5),'Invalid or silent waveform');return {cases:8};});
  await test('TTS-CLIPPING','Each clip has under1percent full-scale samples',()=>{require(report.cases.every(x=>x.stats.clippedFraction<.01),'Excessive clipping');return {maximumClippedFraction:Math.max(...report.cases.map(x=>x.stats.clippedFraction))};});
  await test('TTS-MISSING-SPEAKER','Missing speaker embedding is rejected',async()=>{let error;try{await pipe('A flat in London.',{});}catch(e){error=e.message;}require(error,'Missing speaker accepted');return {error};});
  await test('TTS-WRONG-SPEAKER','Wrong speaker dimension is rejected',async()=>{let error;try{await pipe('A flat in London.',{speaker_embeddings:new Float32Array(511)});}catch(e){error=e.message;}require(error,'Wrong speaker dimension accepted');return {error};});
  await test('TTS-BATCH','Two texts produce two finite audio outputs',async()=>{const result=await measured(()=>pipe(['A flat in London.','A house in Bristol.'],{speaker_embeddings:new lib.Tensor('float32',speaker,[1,512])}));require(Array.isArray(result.value)&&result.value.length===2&&result.value.every(x=>x.audio.length>0),'Expected two audio outputs');return {count:result.value.length,durationMs:result.durationMs};});
  const warm=[];for(let i=0;i<3;i++){const run=await measured(()=>pipe('A flat in London.',{speaker_embeddings:speaker}));warm.push(run.durationMs);}report.observations.warm=statistics(warm);report.observations.latencyMs=statistics(report.cases.map(x=>x.durationMs));report.observations.realTimeFactor=statistics(report.cases.map(x=>x.realTimeFactor));
 }
 if(key==='M5'){
  const data=await loadJSON('data/generation-fixtures.json');report.dataset={fixtureSha256:hash(await readFile(path.join(ROOT,'data/generation-fixtures.json'))),cases:data.cases.length,notes:data.notes};report.settings.generation=data.generation;
  const invoke=async item=>{let firstTokenMs=null,generatedTokenCount=0,streamText='';const start=performance.now();const streamer=new lib.TextStreamer(pipe.tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:text=>{streamText+=text;},token_callback_function:tokens=>{if(firstTokenMs===null)firstTokenMs=performance.now()-start;generatedTokenCount+=tokens.length;}});const run=await measured(()=>pipe([{role:'system',content:data.system},{role:'user',content:item.prompt}],{...data.generation,streamer}));const generated=run.value[0].generated_text,output=Array.isArray(generated)?generated.at(-1).content:generated;return {output,durationMs:run.durationMs,memory:run.memory,firstTokenMs,generatedTokenCount,tokensPerSecond:generatedTokenCount/(run.durationMs/1000),streamText,score:generationScore(item,output)};};
  for(const item of data.cases){const result=await invoke(item);report.cases.push({...item,...result});await flush();trace('case-complete',{id:item.id,category:item.category,passed:result.score.passed,durationMs:result.durationMs,output:result.output});}
  report.observations.byCategory=Object.fromEntries([...new Set(data.cases.map(x=>x.category))].map(category=>{const rows=report.cases.filter(x=>x.category===category);return [category,{cases:rows.length,passed:rows.filter(x=>x.score.passed).length,latencyMs:statistics(rows.map(x=>x.durationMs))}];}));
  report.observations.latencyMs=statistics(report.cases.map(x=>x.durationMs));report.observations.firstTokenMs=statistics(report.cases.map(x=>x.firstTokenMs));report.observations.totalGeneratedTokens=report.cases.reduce((sum,x)=>sum+x.generatedTokenCount,0);report.observations.totalGenerationMs=report.cases.reduce((sum,x)=>sum+x.durationMs,0);report.observations.weightedTokensPerSecond=report.observations.totalGeneratedTokens/(report.observations.totalGenerationMs/1000);
  await test('GEN-OUTPUT','All24 prompts produce non-empty text',()=>{require(report.cases.length===24&&report.cases.every(x=>typeof x.output==='string'&&x.output.length>0),'Empty output');return {cases:24};});
  await test('GEN-TOKEN-LIMIT','All generated counts stay within96newtokens',()=>{require(report.cases.every(x=>x.generatedTokenCount<=96),'Token limit exceeded');return {maximum:Math.max(...report.cases.map(x=>x.generatedTokenCount))};});
  await test('GEN-STREAM','Streamed text matches final assistant text',()=>{require(report.cases.every(x=>x.streamText.trim()===x.output.trim()),'Stream/final output mismatch');return {cases:24};});
  await test('GEN-REPEAT','Greedy repeated prompt returns identical text',async()=>{const run=await invoke(data.cases[0]);require(run.output===report.cases[0].output,'Greedy repeated text changed');return {durationMs:run.durationMs,text:run.output};});
  await test('GEN-BATCH','Two chats produce two output rows',async()=>{const chats=data.cases.slice(8,10).map(x=>[{role:'system',content:data.system},{role:'user',content:x.prompt}]);const run=await measured(()=>pipe(chats,{do_sample:false,max_new_tokens:16}));require(Array.isArray(run.value)&&run.value.length===2,'Expected two generated chats');return {outputs:run.value,durationMs:run.durationMs};});
 }
 await test(key+'-OFFLINE','Controlled inference made no network requests',()=>{require(report.networkAttempts.length===0,'Unexpected network access');return {networkAttempts:0};});
 report.summary={technical:{total:report.tests.length,passed:report.tests.filter(x=>x.status==='passed').length,failed:report.tests.filter(x=>x.status==='failed').length},cases:report.cases.length,...(key==='M5'?{automatedConstraintPasses:report.cases.filter(x=>x.score.passed).length}:{})};
 report.status='completed';
}catch(error){report.status='failed';report.fatal={message:error.message,stack:error.stack};process.exitCode=1;}
finally{if(pipe){try{await pipe.dispose();}catch{}}if(vocoder){try{await vocoder.dispose();}catch{}}report.completedAt=new Date().toISOString();await flush();trace('model-validation-finished',{status:report.status,summary:report.summary,fatal:report.fatal?.message});}
