import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT,loadLibrary,loadFixture,dot,statistics,save } from './common.mjs';
const browser=JSON.parse(await readFile(path.join(ROOT,'results/browser-validation.json'),'utf8'));
const library=await loadLibrary();
function compare(a,b){return {cosine:dot(a,b)/Math.sqrt(dot(a,a)*dot(b,b)),maxAbsoluteDifference:Math.max(...a.map((x,i)=>Math.abs(x-b[i])))};}
const report={createdAt:new Date().toISOString(),nodeThreads:4,browserThreads:1,note:'Different runtimes and thread counts on one host. This comparison is not a platform superiority benchmark.',models:{}};
for(const key of ['M1','M2']){
 const loaded=await loadFixture(library.pipeline,key),pipe=loaded.value,inputs=browser.inputs[key];
 const single=[];for(const input of inputs){const out=await pipe([input],key==='M1'?{pooling:'mean',normalize:true}:undefined);single.push(key==='M1'?out.tolist()[0]:out[0]);}
 const batch=await pipe(inputs,key==='M1'?{pooling:'mean',normalize:true}:undefined);
 const batchRows=key==='M1'?batch.tolist():batch;
 const samples=[];for(let i=0;i<3;i++)await pipe([inputs[0]],key==='M1'?{pooling:'mean',normalize:true}:undefined);
 for(let i=0;i<20;i++){const start=performance.now();await pipe([inputs[0]],key==='M1'?{pooling:'mean',normalize:true}:undefined);samples.push(performance.now()-start);}
 report.models[key]={input:inputs[0],nodeSingle:single,nodeBatch:batchRows,nodeWarm:{samplesMs:samples,statisticsMs:statistics(samples)},browserWarm:browser.models[key].warm.statisticsMs,singleComparison:single.map((item,i)=>key==='M1'?compare(item,browser.models[key].single[i].embeddings[0]):{sameLabel:item.label===browser.models[key].single[i].outputs[0].label,scoreDifference:Math.abs(item.score-browser.models[key].single[i].outputs[0].score)}),batchComparison:batchRows.map((item,i)=>key==='M1'?compare(item,browser.models[key].batch4.embeddings[i]):{sameLabel:item.label===browser.models[key].batch4.outputs[i].label,scoreDifference:Math.abs(item.score-browser.models[key].batch4.outputs[i].score)})};
 await pipe.dispose();
}
await save('backend-comparison.json',report);
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.models).map(([key,item])=>[key,{nodeWarm:item.nodeWarm.statisticsMs,singleComparison:item.singleComparison,batchComparison:item.batchComparison}]))));
