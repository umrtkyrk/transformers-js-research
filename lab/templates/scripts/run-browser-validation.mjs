import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { startServer } from './serve.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = path.join(ROOT, 'results');
const PLAYWRIGHT_ROOT = process.env.PLAYWRIGHT_ROOT ?? path.join(ROOT,'node_modules/playwright');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const GUIDE_TIMEOUT_MS = Number(process.env.GUIDE_TIMEOUT_MS ?? 180000);
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 240000);
const WARM_RUNS = Number(process.env.BROWSER_WARM_RUNS ?? 20);
const INPUTS = {
  M1: ['A bright two-bedroom flat in Manchester', 'A detached house with a garden in Bristol', 'A quiet cottage near Oxford', 'A city centre flat in Leeds'],
  M2: ['I love this flat in London!', 'This viewing was terrible.', 'The letting agent was excellent.', 'I hate waiting for the agent.'],
};

function stats(values) {
  const sorted = values.slice().sort((a,b) => a-b);
  if (!sorted.length) return { count: 0 };
  return { count: values.length, minimum: sorted[0], maximum: sorted.at(-1), median: sorted[Math.ceil(sorted.length*.5)-1], p95: sorted[Math.ceil(sorted.length*.95)-1], mean: values.reduce((a,b)=>a+b,0)/values.length };
}
function vectorComparison(a,b) {
  let dot=0, aa=0, bb=0, maximumAbsoluteDifference=0, squared=0;
  for(let i=0;i<Math.max(a.length,b.length);i++) {
    if(!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return { sameLength: a.length===b.length, allFinite: false };
    dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i];
    const delta=Math.abs(a[i]-b[i]); maximumAbsoluteDifference=Math.max(maximumAbsoluteDifference,delta); squared+=delta*delta;
  }
  return { sameLength: a.length===b.length, allFinite: true, cosineSimilarity: dot/Math.sqrt(aa*bb), maximumAbsoluteDifference, euclideanDistance: Math.sqrt(squared) };
}
function monitor(context, name, baseURL, target) {
  const origin = new URL(baseURL).origin;
  const byRequest = new WeakMap();
  const group = { context:name, phase:'startup', requests:[], console:[], pageErrors:[], blockedExternal:[] };
  target.push(group);
  context.on('request', request => {
    const url=request.url();
    const item={ url, method:request.method(), resourceType:request.resourceType(), phase:group.phase, timestamp:new Date().toISOString(), external:/^https?:/.test(url) && new URL(url).origin!==origin };
    group.requests.push(item); byRequest.set(request,item);
  });
  context.on('response', async response => {
    const item=byRequest.get(response.request());
    if(item) { item.status=response.status(); item.contentLength=response.headers()['content-length']??null; item.fromServiceWorker=response.fromServiceWorker(); }
  });
  context.on('requestfailed', request => { const item=byRequest.get(request); if(item) item.error=request.failure()?.errorText??'requestfailed'; });
  context.on('page', page => {
    page.on('console', message => group.console.push({type:message.type(),text:message.text(),phase:group.phase}));
    page.on('pageerror', error => group.pageErrors.push({message:error.message,stack:error.stack,phase:group.phase}));
  });
  return group;
}
async function cacheSnapshot(page) {
  return page.evaluate(async () => {
    if(!('caches' in window)) return { supported:false };
    const stores=[];
    for(const name of await caches.keys()) { const cache=await caches.open(name); stores.push({ name, urls:(await cache.keys()).map(request=>request.url) }); }
    return { supported:true, stores };
  });
}
async function ready(page, baseURL) {
  await page.goto(baseURL+'/app.html', {waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(() => Boolean(window.validationApi), null, {timeout:30000});
  return page.evaluate(() => window.validationApi.ready);
}

const report = {
  startedAt:new Date().toISOString(), purpose:'Actual browser validation with exact __PACKAGE_VERSION__ and pinned local fixtures',
  harnessRuntime:{node:process.version,platform:process.platform,arch:process.arch},
  intendedRuntime:{browser:'Microsoft Edge headless',backend:'wasm',numThreads:1,worker:true},
  notes:[
    'All timing observations describe this host and headless browser only.',
    'Worker elapsedMs wraps the pipeline call; embedding JSON conversion and RPC are outside it.',
    'No WebGPU model inference is implemented. Adapter capability is probed only.',
    'Routing blocks external fixture requests and disables HTTP cache in Playwright. Cache reload concerns explicit Cache API, not a controlled browser HTTP cache benchmark.',
    'Server bytesReadForResponse counts read stream bytes, not packet-level transferred bytes.',
  ], inputs:INPUTS, network:[], models:{}, failures:[],
};
await mkdir(RESULTS,{recursive:true});
const running=await startServer();
let browser;
try {
  let playwright;
  try { playwright=await import(pathToFileURL(path.join(PLAYWRIGHT_ROOT,'index.mjs')).href); report.playwrightImport='ESM index.mjs'; }
  catch(error) { playwright=createRequire(import.meta.url)(PLAYWRIGHT_ROOT); report.playwrightImport='createRequire fallback'; report.playwrightImportFallbackReason=error.message; }
  browser=await playwright.chromium.launch({headless:true,executablePath:EDGE,timeout:30000});
  report.browserVersion=browser.version();
  console.log(JSON.stringify({event:'browser-launched',version:report.browserVersion}));
  report.guide={ sourceSha256:createHash('sha256').update(await readFile(path.join(ROOT,'browser','guide.html'))).digest('hex'),url:running.baseURL+'/guide.html',timeoutMs:GUIDE_TIMEOUT_MS };

  const guideContext=await browser.newContext({viewport:{width:1100,height:900}});
  const guideNet=monitor(guideContext,'original-guide',running.baseURL,report.network);
  guideNet.phase='original-guide-cdn';
  const guidePage=await guideContext.newPage();
  const guideStart=performance.now();
  try {
    await guidePage.goto(report.guide.url,{waitUntil:'domcontentloaded',timeout:30000});
    await guidePage.waitForFunction(() => { const text=document.querySelector('#result')?.textContent??''; return text && !text.includes('Loading model...'); },null,{timeout:GUIDE_TIMEOUT_MS});
    const text=await guidePage.locator('#result').innerText();
    report.guide.text=text;
    try { const output=JSON.parse(text); report.guide.output=output; report.guide.status=Array.isArray(output) && output[0]?.label==='POSITIVE' && Number.isFinite(output[0]?.score) ? 'passed' : 'unexpected-output'; }
    catch { report.guide.status='page-reported-error'; }
  } catch(error) { report.guide.status=error.name==='TimeoutError'?'timeout':'failed'; report.guide.error={name:error.name,message:error.message}; report.guide.text=await guidePage.locator('#result').innerText().catch(()=>null); }
  finally { report.guide.wallMs=performance.now()-guideStart; console.log(JSON.stringify({event:'original-browser-guide-complete',status:report.guide.status,wallMs:report.guide.wallMs})); await guideContext.close(); }

  const context=await browser.newContext({viewport:{width:1100,height:950}});
  const localNet=monitor(context,'local-fixture-app',running.baseURL,report.network);
  await context.route('**/*', route => {
    const url=route.request().url();
    if(/^https?:/.test(url) && new URL(url).origin!==running.baseURL) { localNet.blockedExternal.push({url,phase:localNet.phase}); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page=await context.newPage(); page.setDefaultTimeout(MODEL_TIMEOUT_MS);
  localNet.phase='fixture-init';
  report.workerEnvironment=await ready(page,running.baseURL);
  report.pageEnvironment=await page.evaluate(() => ({userAgent:navigator.userAgent,platform:navigator.platform,language:navigator.language,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemoryGiB:navigator.deviceMemory??null,isSecureContext,crossOriginIsolated,performanceMemory:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit,note:'Main JavaScript heap only, not total browser or model memory.'}:null}));
  report.webgpuProbe=await page.evaluate(() => window.validationApi.probeWebGPU());

  for(const key of ['M1','M2']) {
    const model={key,inputs:INPUTS[key]}; report.models[key]=model;
    try {
      localNet.phase=key+'-initial-local-load';
      const requestStart=running.requests.length;
      model.load=await page.evaluate(key => window.validationApi.load(key),key);
      console.log(JSON.stringify({event:'browser-fixture-loaded',key,loadMs:model.load.loadMs}));
      model.loadRequests=running.requests.slice(requestStart).map(item=>({...item}));
      localNet.phase=key+'-single-vs-batch4';
      model.single=[];
      for(const text of INPUTS[key]) model.single.push(await page.evaluate(text => window.validationApi.infer(text),text));
      model.batch4=await page.evaluate(inputs => window.validationApi.infer(inputs),INPUTS[key]);
      model.outputChecks=key==='M1'
        ? {batchRows:model.batch4.embeddings.length,expectedBatchRows:4,shape:model.batch4.dims,expectedShape:[4,report.workerEnvironment.fixtures.models[0].expectedDimensions],allFinite:model.batch4.embeddings.every(row=>row.every(Number.isFinite)),maximumNormDeviationFromOne:Math.max(...model.batch4.norms.map(value=>Math.abs(value-1)))}
        : {batchRows:model.batch4.outputs.length,expectedBatchRows:4,expectedLabels:['POSITIVE','NEGATIVE','POSITIVE','NEGATIVE'],actualLabels:model.batch4.outputs.map(item=>item.label),allScoresFiniteAndInUnitInterval:model.batch4.outputs.every(item=>Number.isFinite(item.score)&&item.score>=0&&item.score<=1)};
      model.outputChecks.passed=key==='M1'
        ? model.outputChecks.batchRows===4 && model.outputChecks.shape[0]===4 && model.outputChecks.shape[1]===report.workerEnvironment.fixtures.models[0].expectedDimensions && model.outputChecks.allFinite && model.outputChecks.maximumNormDeviationFromOne<=.001
        : model.outputChecks.batchRows===4 && model.outputChecks.allScoresFiniteAndInUnitInterval && model.outputChecks.actualLabels.every((label,index)=>label===model.outputChecks.expectedLabels[index]);
      model.outputChecks.scope=key==='M1'?'Numerical sanity: shape, finite values, normalized vector tolerance 0.001.':'Four obvious English sentiment examples only; not a representative quality benchmark.';
      if(!model.outputChecks.passed) report.failures.push({phase:localNet.phase,key,reason:'output-check-failed'});
      model.batchConsistency=key==='M1'
        ? model.single.map((item,index)=>vectorComparison(item.embeddings[0],model.batch4.embeddings[index]))
        : model.single.map((item,index)=>({sameLabel:item.outputs[0].label===model.batch4.outputs[index].label,absoluteScoreDifference:Math.abs(item.outputs[0].score-model.batch4.outputs[index].score)}));
      localNet.phase=key+'-warm-timing';
      await page.evaluate(() => window.validationApi.startUiProbe());
      const timings=[];
      for(let index=0;index<WARM_RUNS;index++) { const output=await page.evaluate(text => window.validationApi.infer(text),INPUTS[key][0]); timings.push(output.elapsedMs); }
      model.warm={samplesMs:timings,statisticsMs:stats(timings),input:INPUTS[key][0],warmupCallsBeforeMeasurements:5};
      model.uiResponsiveness=await page.evaluate(() => window.validationApi.stopUiProbe());

      localNet.phase=key+'-invalid-application-input';
      model.invalidInputs=await page.evaluate(async () => {
        const cases=[{name:'empty-array',value:[]},{name:'empty-string',value:''},{name:'null',value:null},{name:'number',value:42},{name:'too-many-items',value:Array(33).fill('example')}];
        const results=[];
        for(const item of cases) { const before=window.validationApi.getMetrics().rpcIssuedCount; try { await window.validationApi.infer(item.value); results.push({name:item.name,rejected:false}); } catch(error) { results.push({name:item.name,rejected:true,code:error.code,message:error.message,rpcIssuedDelta:window.validationApi.getMetrics().rpcIssuedCount-before,visibleError:document.getElementById('error').textContent}); } }
        return results;
      });

      localNet.phase=key+'-offline-already-ready';
      await context.setOffline(true);
      try { model.offlineReady={status:'passed',output:await page.evaluate(text => window.validationApi.infer(text),INPUTS[key][0]),condition:'Only inference after model and WASM were already loaded; no offline cold-start claim.'}; }
      catch(error) { model.offlineReady={status:'failed',error:{name:error.name,message:error.message}}; }
      finally { await context.setOffline(false); }

      if(key==='M1') {
        model.cacheBeforeReload=await cacheSnapshot(page);
        await page.evaluate(() => window.validationApi.dispose());
        localNet.phase='M1-cache-api-reload';
        await ready(page,running.baseURL);
        const reloadStart=running.requests.length;
        model.cachedReload={ load:await page.evaluate(() => window.validationApi.load('M1')), note:'New page and worker, same browser context. Explicit Cache API may persist; HTTP cache disabled by routing.' };
        model.cachedReload.output=await page.evaluate(text => window.validationApi.infer(text),INPUTS.M1[0]);
        model.cachedReload.serverRequests=running.requests.slice(reloadStart).map(item=>({...item}));
        model.cachedReload.cacheAfterReload=await cacheSnapshot(page);
      }
      model.status='completed';
      console.log(JSON.stringify({event:'browser-fixture-tests-complete',key,warm:model.warm.statisticsMs}));
    } catch(error) { model.status='failed'; model.error={name:error.name,message:error.message,stack:error.stack}; report.failures.push({phase:localNet.phase,key,error:model.error}); }
    if(key==='M1') await page.evaluate(() => window.validationApi.dispose()).catch(error=>{report.failures.push({phase:'M1-dispose',message:error.message});});
  }
  localNet.phase='final-screenshot';
  await page.screenshot({path:path.join(RESULTS,'browser.png'),fullPage:true});
  report.finalCache=await cacheSnapshot(page);
  report.localNetworkSummary={externalAttemptCount:localNet.requests.filter(item=>item.external).length,blockedExternal:localNet.blockedExternal,requestCount:localNet.requests.length,failedRequests:localNet.requests.filter(item=>item.error),httpErrors:localNet.requests.filter(item=>item.status>=400)};
  await page.evaluate(() => window.validationApi.dispose()).catch(()=>{});
  await context.close();
} catch(error) {
  report.failures.push({phase:'harness',name:error.name,message:error.message,stack:error.stack});
  process.exitCode=1;
} finally {
  if(browser) await browser.close().catch(()=>{});
  await running.close().catch(error=>report.failures.push({phase:'server-close',message:error.message}));
  report.serverRequests=running.requests;
  report.finishedAt=new Date().toISOString();
  report.status=report.failures.length?'failed':'completed';
  if(report.failures.length) process.exitCode=1;
  await writeFile(path.join(RESULTS,'browser-validation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({event:'browser-validation-finished',results:path.join(RESULTS,'browser-validation.json'),models:Object.fromEntries(Object.entries(report.models).map(([key,value])=>[key,value.status])),guide:report.guide?.status,failures:report.failures.length}));
}
