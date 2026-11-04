export const REPOSITORY='umrtkyrk/transformers-js-research';
export const WORKFLOW='research.yml';
export const RESULTS_BRANCH='results';
const origin='https://transformers-js-research.vercel.app';
const activeStatuses=new Set(['queued','in_progress','waiting','requested','pending']);
const stable=v=>typeof v==='string'&&/^4\.\d+\.\d+$/.test(v);

export async function github(endpoint,{fetcher=fetch,token=process.env.LAB_GITHUB_TOKEN,method='GET',body}={}){
 const response=await fetcher('https://api.github.com/repos/'+REPOSITORY+'/'+endpoint,{method,signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'TransformersJS-Research',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Object.assign(new Error('GitHub request failed ('+response.status+')'),{status:response.status});
 return response.status===204?null:response.json();
}

const revisionCache=new WeakMap();
export async function resultRevision({fetcher=fetch,token=process.env.LAB_GITHUB_TOKEN}={}){
 const saved=revisionCache.get(fetcher);if(saved&&saved.expires>Date.now())return saved.promise;
 const promise=github('git/ref/heads/'+RESULTS_BRANCH,{fetcher,token}).then(ref=>{
  if(!/^[a-f0-9]{40}$/.test(ref.object?.sha))throw new Error('Invalid results commit');return ref.object.sha;
 }).catch(error=>{if(error.status===404)return null;revisionCache.delete(fetcher);throw error;});
 revisionCache.set(fetcher,{expires:Date.now()+10000,promise});return promise;
}

export async function releaseStatus({fetcher=fetch,token=process.env.LAB_GITHUB_TOKEN}={}){
 const [npm,history,workflows]=await Promise.all([
  fetcher('https://registry.npmjs.org/@huggingface%2ftransformers/latest',{signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)throw new Error('npm unavailable');return r.json()}),
  resultRevision({fetcher,token}).then(revision=>revision?fetcher('https://raw.githubusercontent.com/'+REPOSITORY+'/'+revision+'/lab/catalog.json',{signal:AbortSignal.timeout(15000)}).then(r=>r.ok?r.json():Promise.reject(new Error('Recorded results unavailable'))):{runs:[]}),
  github('actions/workflows/'+WORKFLOW+'/runs?per_page=20',{fetcher,token})
 ]);
 const running=workflows.workflow_runs?.find(x=>activeStatuses.has(x.status));
 const publicRun=x=>x?{id:x.id,status:x.status,conclusion:x.conclusion,url:x.html_url,createdAt:x.created_at}:null;
 const completed=history.runs?.filter(x=>x.status==='completed')??[];
 const tested=completed.some(x=>x.version===npm.version);
 const lastRun=workflows.workflow_runs?.[0];
 const failed=lastRun?.status==='completed'&&['failure','timed_out','cancelled'].includes(lastRun.conclusion)&&String(lastRun.display_title??'').includes(npm.version);
 const status=!stable(npm.version)?'needs-review':running?'running':tested?'up-to-date':failed?'failed':'new-version';
 return {status,latest:npm.version,tested,configured:Boolean(token),run:publicRun(running??(failed?lastRun:null)),completedRuns:completed.length};
}

export async function checkHandler(req,res,{fetcher=fetch,token=process.env.LAB_GITHUB_TOKEN}={}){
 res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
 const send=(code,value)=>{res.statusCode=code;res.end(JSON.stringify(value));};
 if(!['GET','POST'].includes(req.method))return send(405,{error:'Method not allowed'});
 if(req.method==='POST'&&req.headers.origin!==origin)return send(403,{error:'This action must be requested from the research site'});
 // No client-supplied package, command, model, ref or force option is accepted.
 try{
  const result=await releaseStatus({fetcher,token});
  if(req.method==='GET'||['running','up-to-date','needs-review','failed'].includes(result.status))return send(200,result);
  if(!token)return send(503,{...result,error:'GitHub Actions bağlantısı henüz etkinleştirilmedi.'});
  await github('actions/workflows/'+WORKFLOW+'/dispatches',{fetcher,token,method:'POST',body:{ref:'main',inputs:{mode:'auto',version:result.latest}}});
  return send(202,{...result,status:'queued'});
 }catch{return send(503,{status:'unavailable',error:'Sürüm veya çalışma durumuna şu anda erişilemiyor. Daha sonra yeniden deneyin.'});}
}

export function artifactPath(value){
 let candidate=String(value??'').replace(/^\/+|\/+$/g,'')||'index.html';
 if(candidate==='local')candidate='local/index.html';
 if(!/^[\w./-]+$/.test(candidate)||!candidate.split('/').every(x=>x&&x!=='.'&&x!=='..')||!/\.(html|json|png|wav)$/.test(candidate))throw new Error('Invalid artifact path');
 return candidate;
}

export async function artifactHandler(req,res,{fetcher=fetch,readFallback}={}){
 if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end();}
 let relative;try{relative=artifactPath(new URL(req.url,'https://local.invalid').searchParams.get('path'));}catch{res.statusCode=400;return res.end('Invalid path');}
 const mime={html:'text/html; charset=utf-8',json:'application/json; charset=utf-8',png:'image/png',wav:'audio/wav'};
 try{
  if(relative.startsWith('local/')&&readFallback){
   const localPath=relative.slice(6);let content=await readFallback(localPath);
   if(localPath.endsWith('.html'))content=content.toString('utf8').replace(/href="(?:\.\.\/)+styles\.css"/g,'href="/styles.css"').replace('<main class="lab-page">','<main class="lab-page"><div class="notice">Önceki yerel deneylerin arşivi. Buradaki zamanlayıcı bilgisi tarihsel kayıttır. <a href="/lab/">Güncel GitHub Actions sonuçları</a>.</div>');
   res.setHeader('Content-Type',mime[relative.split('.').at(-1)]);res.setHeader('Cache-Control','no-store');res.statusCode=200;return res.end(req.method==='HEAD'?undefined:content);
  }
  const revision=await resultRevision({fetcher});
  const response=revision?await fetcher('https://raw.githubusercontent.com/'+REPOSITORY+'/'+revision+'/lab/'+relative,{signal:AbortSignal.timeout(15000)}):{status:404,ok:false};
  let content;
  if(response.ok)content=Buffer.from(await response.arrayBuffer());
  else if(response.status===404&&readFallback)content=await readFallback(relative);
  else {res.statusCode=response.status===404?404:502;return res.end('Recorded result unavailable');}
  res.setHeader('Content-Type',mime[relative.split('.').at(-1)]);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.statusCode=200;return res.end(req.method==='HEAD'?undefined:content);
 }catch{res.statusCode=503;return res.end('Recorded result temporarily unavailable');}
}
