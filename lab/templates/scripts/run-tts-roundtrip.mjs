import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {ROOT,config,loadJSON,saveJSON,readWave,speechScore,hash} from './extended-utils.mjs';
import {measured,statistics} from './common.mjs';
globalThis.fetch=()=>{throw new Error('Network disabled');};
const {pipeline,env}=await import('@huggingface/transformers');
env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=path.join(ROOT,'.cache/models')+path.sep;env.useFSCache=false;
const m=config.models.find(x=>x.key==='M3');
const tts=await loadJSON('results/extended/m4-validation.json');
const pipe=await pipeline(m.task,m.id,{revision:m.revision,dtype:m.dtype,device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});
const result={startedAt:new Date().toISOString(),purpose:'Coupled SpeechT5 to Whisper diagnostic, not human intelligibility, naturalness or speaker similarity validation',ttsResultSha256:hash(await readFile(path.join(ROOT,'results/extended/m4-validation.json'))),asrModel:m,cases:[]};
try{for(const item of tts.cases){const wave=await readWave(path.join(ROOT,item.wav));const run=await measured(()=>pipe(wave.audio,{language:'english',task:'transcribe',do_sample:false,max_new_tokens:128}));result.cases.push({id:item.id,reference:item.text,prediction:run.value.text,wav:item.wav,sha256:wave.sha256,durationMs:run.durationMs,score:speechScore(item.text,run.value.text,item.required_phrases||[])});console.log(JSON.stringify({id:item.id,prediction:run.value.text}));await saveJSON('tts-roundtrip.json',result);}result.summary={cases:result.cases.length,referenceWords:result.cases.reduce((s,x)=>s+x.score.referenceWords,0),wordErrors:result.cases.reduce((s,x)=>s+x.score.wordErrors,0)};result.summary.wer=result.summary.wordErrors/result.summary.referenceWords;result.status='completed';}finally{await pipe.dispose();result.completedAt=new Date().toISOString();await saveJSON('tts-roundtrip.json',result);}
