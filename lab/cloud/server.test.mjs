import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHandler,artifactHandler,artifactPath,releaseStatus,resultRevision} from './server.mjs';
const origin='https://transformers-js-research.vercel.app';
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,arrayBuffer:async()=>Buffer.from(value)});
function fixture({version='4.3.3',tested=false,running=false,failed=false,broken=false}={}){
 const calls=[];const fetcher=async(url,options={})=>{
  calls.push({url,options});if(broken)throw new Error('Offline');
  if(url.includes('registry.npmjs.org'))return response({version});
  if(url.includes('/git/ref/heads/results'))return response({object:{sha:'a'.repeat(40)}});
  if(url.includes('raw.githubusercontent.com'))return response({runs:tested?[{version,status:'completed'}]:[]});
  if(options.method==='POST')return response(null,204);
  return response({workflow_runs:running?[{id:12,status:'in_progress',html_url:'https://github.com/umrtkyrk/transformers-js-research/actions/runs/12'}]:failed?[{id:11,status:'completed',conclusion:'failure',display_title:'Research auto '+version}]:[]});
 };return {fetcher,calls};
}
async function request(options={},method='POST',requestOrigin=origin){
 const f=fixture(options);let body;
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(value){body=JSON.parse(value);}};
 await checkHandler({method,headers:{origin:requestOrigin}},res,{fetcher:f.fetcher,token:'test-only-not-a-secret'});
 return {...f,status:res.statusCode,body};
}
test('New stable package dispatches only the server-selected main workflow',async()=>{
 const result=await request();assert.equal(result.status,202);assert.equal(result.body.status,'queued');
 const dispatch=result.calls.find(x=>x.options.method==='POST');assert.deepEqual(JSON.parse(dispatch.options.body),{ref:'main',inputs:{mode:'auto',version:'4.3.3'}});
});
test('Completed or active work does not dispatch again',async()=>{
 for(const options of [{tested:true},{running:true},{failed:true}]){const result=await request(options);assert.equal(result.status,200);assert.ok(!result.calls.some(x=>x.options.method==='POST'));}
});
test('Read-only checks and unsupported major releases never start a runner',async()=>{
 for(const [options,method] of [[{},'GET'],[{version:'5.0.0'},'POST'],[{version:'4.4.0-beta.1'},'POST']]){const result=await request(options,method);assert.ok(!result.calls.some(x=>x.options.method==='POST'));}
});
test('Cross-origin and unsupported methods are rejected before any upstream call',async()=>{
 for(const [method,otherOrigin] of [['POST','https://elsewhere.invalid'],['DELETE',origin]]){const result=await request({},method,otherOrigin);assert.ok([403,405].includes(result.status));assert.equal(result.calls.length,0);}
});
test('Missing credential or upstream failure is explicit and exposes no secrets',async()=>{
 const f=fixture();let result;const res={setHeader(){},end(text){result=JSON.parse(text);}};
 await checkHandler({method:'POST',headers:{origin}},res,{fetcher:f.fetcher,token:''});assert.equal(res.statusCode,503);assert.equal(result.configured,false);
 const broken=await request({broken:true});assert.equal(broken.status,503);assert.ok(!JSON.stringify(broken.body).includes('test-only-not-a-secret'));
});
test('Artifact routing rejects traversal and non-evidence files',()=>{
 for(const value of ['../local.json','runs/../../x.json','C:/x.json','x\\y.json','%2e%2e/a.json','run.log','file.js'])assert.throws(()=>artifactPath(value));
 assert.equal(artifactPath(''),'index.html');assert.equal(artifactPath('runs/test/evidence/test.wav'),'runs/test/evidence/test.wav');
});
test('Missing cloud artifact uses the preserved local evidence',async()=>{
 let output;const res={setHeader(){},end(value){output=value;}};
 await artifactHandler({method:'GET',url:'/api/research-artifact?path=runs/old/run.json'},res,{fetcher:async()=>response(null,404),readFallback:async rel=>Buffer.from(JSON.stringify({rel}))});
 assert.equal(res.statusCode,200);assert.equal(JSON.parse(output).rel,'runs/old/run.json');
});
test('Local archive stays on Vercel and is never fetched from GitHub',async()=>{
 let output;const res={setHeader(){},end(value){output=value;}};
 await artifactHandler({method:'GET',url:'/api/research-artifact?path=local/'},res,{fetcher:async()=>{throw new Error('Must not make an upstream request')},readFallback:async rel=>{assert.equal(rel,'index.html');return Buffer.from('<link href="../styles.css">Local archive')}});
 assert.equal(res.statusCode,200);assert.ok(output.includes('href="/styles.css"'));
});
test('Mutable result branch is resolved to an immutable commit before reading artifacts',async()=>{
 const f=fixture({tested:true});await releaseStatus({fetcher:f.fetcher,token:''});
 assert.ok(f.calls.some(x=>x.url==='https://raw.githubusercontent.com/umrtkyrk/transformers-js-research/'+'a'.repeat(40)+'/lab/catalog.json'));
 assert.ok(!f.calls.some(x=>x.url.includes('/results/lab/catalog.json')));
 await resultRevision({fetcher:f.fetcher,token:''});assert.equal(f.calls.filter(x=>x.url.includes('/git/ref/heads/results')).length,1);
});
