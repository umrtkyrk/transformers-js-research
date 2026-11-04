import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT,loadLibrary,loadFixture,dot,norm,save } from './common.mjs';
const library=await loadLibrary();
const loaded=await loadFixture(library.pipeline,'M1');
const pipe=loaded.value;
const texts=['A bright two-bedroom flat in Manchester','A detached house with a garden in Bristol'];
const long='A spacious flat with bright rooms and a modern kitchen. '.repeat(150);
const samples={};
for(const [name,inputs] of [['single',[texts[0]]],['two-short',texts],['mixed-short-long',[texts[0],long]],['repeated-short',Array(8).fill(texts[0])]]){
 const output=await pipe(inputs,{pooling:'mean',normalize:true});
 const vector=output.tolist()[0];
 samples[name]={inputs:inputs.length,dims:output.dims,norm:norm(vector),vector};
}
const comparisons=Object.entries(samples).filter(([name])=>name!=='single').map(([name,item])=>({name,cosine:dot(samples.single.vector,item.vector),maxAbsoluteDifference:Math.max(...item.vector.map((x,i)=>Math.abs(x-samples.single.vector[i]))),strictPredeclaredTolerancePassed:dot(samples.single.vector,item.vector)>=.9999}));
let streamer;
try{const value=new library.TextStreamer(pipe.tokenizer,{skip_prompt:true});try{value.put([[1n],[2n]]);streamer={passed:false,error:'No rejection'};}catch(error){streamer={passed:error.message.includes('batch size of 1'),error:error.message};}}catch(error){streamer={passed:false,error:error.message};}
const listings=JSON.parse(await readFile(path.join(ROOT,'data/listings.json'),'utf8'));
const consistency=[];
for(const record of listings.slice(0,16)){
 const single=(await pipe(record.text,{pooling:'mean',normalize:true})).tolist()[0];
 const batched=(await pipe([record.text,listings[30].text],{pooling:'mean',normalize:true})).tolist()[0];
 consistency.push({id:record.id,cosine:dot(single,batched),maxAbsoluteDifference:Math.max(...single.map((x,i)=>Math.abs(x-batched[i])))});
}
await pipe.dispose();
await save('consistency-diagnostics.json',{samples,comparisons,listingConsistency:consistency,streamer,predeclaredCosineThreshold:.9999,interpretation:'The strict tolerance is retained; failures are not changed to passes. No fp32 control was run, so quantization is a possible explanation rather than an established cause.'});
console.log(JSON.stringify({comparisons,streamer,listingCosineMinimum:Math.min(...consistency.map(x=>x.cosine))}));
