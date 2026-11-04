import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,WORK,STATE,settings,readJSON,writeJSON,exists,walk,command,saveState} from './core.mjs';

const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number.isFinite(v)?v.toLocaleString('tr-TR',{maximumFractionDigits:2}):'Ölçülmedi';
const pct=v=>Number.isFinite(v)?'%'+n(v*100):'Ölçülmedi';
const statusNames={completed:'Tamamlandı',incomplete:'Eksik koşu',interrupted:'Kesildi',preparing:'Hazırlanıyor',running:'Çalışıyor',queued:'Sırada',failed:'Başarısız',partial:'Kısmen tamamlandı'};
const table=(head,rows,cls='')=>'<div class="table-wrap"><table class="'+e(cls)+'"><thead><tr>'+head.map(x=>'<th>'+e(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map((x,i)=>'<td data-label="'+e(head[i])+'"><div class="cell-value">'+x+'</div></td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const date=v=>v?new Date(v).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'Henüz yapılmadı';
const reason=v=>v==='manual baseline'?'Sabit beşli':v==='cloud verification'?'GitHub Actions ortam doğrulaması':v==='manual forced run'?'Sabit beşli tekrar koşusu':v==='scheduled end-to-end verification'?'Windows zamanlayıcısı tam denemesi':v==='npm stable release'?'Kararlı kütüphane sürümü':String(v).replace('manual compatible model: ','Yeni model: ').replace('new compatible model: ','Yeni model: ').replace('watched model revision: ','Model güncellemesi: ').replace('manual retry','Güncel protokolle tekrar');
const taskLabels={M1:'Anlamsal arama',M2:'Duygu sınıflandırma',M3:'Konuşmadan metne',M4:'Metinden konuşmaya',M5:'Metin üretimi'};
const styles='<style>.lab-page{max-width:1160px;margin:auto;padding:32px 24px}.lab-page h1{font:36px Georgia,serif}.lab-page h2{margin-top:30px}.lab-page .toolbar{margin:22px 0;flex-wrap:wrap}.lab-page code{overflow-wrap:anywhere}.lab-page td{vertical-align:top}.lab-page .notice{margin:18px 0}.lab-page details{margin:16px 0}.lab-page .model-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.lab-page .model-list .panel{margin:0}.lab-page .status-warn{color:#8f3829;font-weight:700}@media(max-width:600px){.lab-page .model-list{grid-template-columns:1fr}.lab-page .table-wrap table{min-width:0;table-layout:fixed}.lab-page th,.lab-page td{overflow-wrap:anywhere;padding:10px 7px}}</style>';
const mobile='<style>@media(max-width:600px){.lab-page th{white-space:normal}.run-history thead{display:none}.run-history,.run-history tbody,.run-history tr,.run-history td{display:block;width:100%}.run-history tr{padding:10px 0;border-bottom:1px solid #dbe1d9}.run-history td{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;box-sizing:border-box;padding:8px 12px;border:0}.run-history td:before{content:attr(data-label);font-weight:700;color:#61716e}}</style>';
const shell=(title,content,css,canonical)=>'<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+e(title)+' · Transformers.js</title><meta name="description" content="Yerel Node.js ve Playwright ile otomatik model deneyleri. Tarihli sonuçlar, başarısız kontroller ve karşılaştırmalar."><link rel="canonical" href="'+e(canonical)+'"><link rel="stylesheet" href="'+css+'">'+styles+mobile+'</head><body><main class="lab-page">'+content+'</main></body></html>';
export function publicCopy(value){
 if(typeof value==='string')return value.replace(/\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/gi,'C:/Research').replace(/https?:\/\/[^\s"'`<>]+/g,url=>{try{const parsed=new URL(url);for(const key of [...parsed.searchParams.keys()])if(/signature|policy|x-amz|token|credential/i.test(key))parsed.searchParams.delete(key);return parsed.href;}catch{return url;}});
 if(Array.isArray(value))return value.map(publicCopy);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(access_?token|authorization|password|secret|api_?key)$/i.test(key)).map(([k,v])=>[k,publicCopy(v)]));
 return value;
}
function metricRows(summary){const m=summary?.metrics??{};return [
 ['Anlamsal ilk sıra',pct(m.semanticHit1)],['Kelime ilk sıra',pct(m.lexicalHit1)],['Duygu etiket doğruluğu',pct(m.sentimentAccuracy)],['Whisper temiz WER',pct(m.cleanWer)],['Whisper gürültülü WER',pct(m.noisyWer)],['Qwen katı JSON',m.jsonCases!=null?n(m.jsonPasses)+'/'+n(m.jsonCases):'Ölçülmedi'],['Qwen dar otomatik koşullar',m.generationCases!=null?n(m.generationConstraints)+'/'+n(m.generationCases):'Ölçülmedi'],['SpeechT5 üretilen ses',n(m.ttsClips)],['TTS geri döküm WER',pct(m.ttsRoundtripWer)],['M1 en iyi gözlenen metin/sn',n(m.bestBatchTextsPerSecond)]];}
function comparable(previous,current){return previous.status==='completed'&&previous.protocolHash===current.protocolHash&&previous.datasetHash===current.datasetHash;}
function changes(previous,current){const rows=[];if(previous.version!==current.version)rows.push('Kütüphane '+previous.version+' → '+current.version);for(const model of current.models){const before=previous.models.find(x=>x.slot===model.slot);if(!before||before.id!==model.id||before.revision!==model.revision||before.dtype!==model.dtype)rows.push(model.slot+' modeli / revizyonu / varyantı');}return rows;}
export async function buildPublic(s){
 const {config}=await settings();const dist=path.resolve(ROOT,config.publish.staticDirectory);const out=path.join(dist,'lab');await fs.mkdir(out,{recursive:true});
 const publicRuns=[];
 for(const record of s.runs){
  const local=path.join(STATE,'jobs',record.id),pub=path.join(out,'runs',record.id);await fs.mkdir(path.join(pub,'evidence'),{recursive:true});
  if(record.evidenceLocation==='existing-publication'&&!(await exists(path.join(local,'results')))){const clean=publicCopy(record);publicRuns.push(clean);await writeJSON(path.join(pub,'run.json'),clean);continue;}
  // A fresh cloud VM restores published evidence, not old private job folders.
  // Keep those complete reports instead of overwriting them with empty evidence lists.
  if(!(await exists(path.join(local,'results')))&&await exists(path.join(pub,'report.html'))){const clean=publicCopy(record);publicRuns.push(clean);await writeJSON(path.join(pub,'run.json'),clean);continue;}
  const evidence=[],evidenceErrors=[];
  if(await exists(path.join(local,'results')))for(const file of await walk(path.join(local,'results'))){
   const rel=path.relative(path.join(local,'results'),file).replaceAll('\\','/');
   if(rel.startsWith('logs/')||!/\.(json|png|wav)$/.test(rel))continue;
   const target=path.join(pub,'evidence',rel);await fs.mkdir(path.dirname(target),{recursive:true});
   if(file.endsWith('.json')){try{await writeJSON(target,publicCopy(await readJSON(file)));}catch(error){evidenceErrors.push({path:rel,error:'JSON evidence could not be parsed; original local file retained.'});continue;}}else await fs.copyFile(file,target);evidence.push(rel);
  }
  const clean=publicCopy(record);if(evidenceErrors.length)clean.evidenceErrors=evidenceErrors;await writeJSON(path.join(pub,'run.json'),clean);publicRuns.push(clean);
  const prior=s.runs.filter(x=>x.id!==record.id&&comparable(x,record)&&changes(x,record).length<=1&&x.startedAt<record.startedAt).at(-1);
  const metrics=metricRows(record.summary),counts=record.summary?.technical;
  let content='<nav class="toolbar"><a class="button" href="../../">Otomatik deneyler</a><a class="button" href="/versions/4.3.2/">Araştırma</a><a class="button" href="run.json">Koşu JSON</a></nav><h1>Deney kaydı</h1><p><strong>'+e(statusNames[record.status]??record.status)+'</strong> · Transformers.js '+e(record.version)+' · '+e(date(record.startedAt))+'</p>'+
   '<p>'+e(reason(record.reason))+'</p>'+(record.error?'<div class="notice warn">'+e(record.error)+'</div>':'')+
   '<section class="decision-summary"><h2>Bu koşuda ne oldu?</h2><p>'+(counts?e(counts.total)+' kaydedilmiş teknik kontrolde '+e(counts.passed)+' geçti, '+e(counts.failed)+' başarısız. Beklenen ortak protokol '+e(counts.expected)+' kontroldür.':'Teknik kontroller tamamlanamadı.')+' '+(record.summary?.complete?'Bütün ortak aşamalar tamamlandı.':'Eksik aşamalar bulundu; bu kayıt tam değerlendirme olarak kullanılmaz.')+'</p></section>'+
   '<p class="muted">Ücretli LLM API entegrasyonu yoktur. Teknik kontrol oranı cevap doğruluğu değildir. Tek makine ve kurgusal İngiltere CRM verileri; mobil, WebGPU çıkarımı, Türkçe kalite ve insan konuşması kapsam dışıdır.</p>'+
   '<h2>Çalıştırılan modeller</h2>'+table(['Görev','Model','Sabit revizyon','Varyant'],record.models.map(x=>[e(x.slot),e(x.id),'<code>'+e(x.revision)+'</code>',e(x.dtype)]))+
   '<h2>Ölçümler</h2>'+table(['Ölçü','Bu koşu'],metrics.map(row=>row.map(e)));
  if(prior){const axes=changes(prior,record);const previous=metricRows(prior.summary);content+='<h2>Önceki uygun koşuyla karşılaştırma</h2><p>Değişen bileşen: '+e(axes.join(', ')||'Aynı model ve sürüm; tekrar koşusu')+'. <a href="../'+e(prior.id)+'/report.html">Önceki kaydı aç</a>.</p>'+table(['Ölçü','Önceki','Bu koşu'],metrics.map((row,i)=>[e(row[0]),e(previous[i][1]),e(row[1])]))+'<p>Süreler farklı tarihlerde ve sistem yüklerinde ölçülür; tek koşu farkından sürüm kaynaklı hızlanma/gerileme sonucu çıkarılmaz. SpeechT5 rastgeleliği sabitlenmedi; geri döküm insan doğallık puanı değildir.</p>';}
  content+='<h2>Başarısız kontroller</h2>'+(record.summary?.failures?.length?table(['Kimlik','Gerçek hata'],record.summary.failures.map(x=>[e(x.id),e(publicCopy(x.error))])):'<p>Kaydedilmiş başarısız kontrol yok. Eksik koşularda bu, bütün kontrollerin geçtiğini göstermez.</p>')+
   (record.summary?.auxiliaryFailures?.length?'<h2>Yardımcı aşama sorunları</h2>'+table(['Aşama','Durum'],record.summary.auxiliaryFailures.map(x=>[e(x.id),e(x.error)])):'')+
   '<details><summary>Ortam ve tekrar üretim bilgisi</summary><pre>'+e(JSON.stringify(publicCopy({execution:record.execution,environment:record.summary?.environment,protocolHash:record.protocolHash,datasetHash:record.datasetHash,models:record.models}),null,2))+'</pre></details>'+
   '<h2>Ham kanıtlar</h2>'+(evidenceErrors.length?'<p class="status-warn">'+e(evidenceErrors.length)+' kanıt dosyası okunamadı; özgün dosyalar yerelde korundu.</p>':'')+'<ul>'+evidence.map(rel=>'<li><a href="evidence/'+rel.split('/').map(encodeURIComponent).join('/')+'">'+e(rel)+'</a></li>').join('')+'</ul>';
  await fs.writeFile(path.join(pub,'report.html'),shell('Deney '+record.version,content,'../../../styles.css',config.publish.baseUrl+'lab/runs/'+record.id+'/report.html'));
 }
 const active=s.queue.filter(x=>x.status==='queued');
 const last=s.lastCheck;
 const cloud=config.execution?.kind==='GitHub Actions';
 const cloudControls='<section class="panel" aria-labelledby="cloud-heading"><h2 id="cloud-heading">Sürüm kontrolü</h2><p>Yeni kararlı sürüm varsa testler GitHub Actions üzerinde başlar.</p><button class="button primary" id="check-release" type="button">Yeni sürümü kontrol et</button><p id="cloud-status" role="status" aria-live="polite">Kontrol için düğmeye basın.</p><a id="cloud-run-link" hidden target="_blank" rel="noopener noreferrer">GitHub çalışma kaydı</a></section><p><a class="button" href="/lab/local/">Önceki yerel deneylerin arşivi</a></p><script src="/lab-cloud-client.js" defer></script>';
 const content='<nav class="toolbar"><a class="button" href="/">4.3.1 araştırması</a><a class="button" href="/versions/4.3.2/">4.3.2 araştırması</a><a class="button" href="/versions/compare.html">Sürüm karşılaştırması</a></nav><h1>Otomatik deneyler</h1>'+
  '<p>Seçili modeller ve kararlı Transformers.js sürümleri takip edilir. Node.js ve Playwright testleri çalıştırır; raporlar ölçümlerden normal kodla üretilir.</p>'+
  '<section class="decision-summary"><h2>Takip durumu</h2><p>Son kontrol: '+e(date(last?.at))+' · '+e(last?statusNames[last.status]:'Henüz kontrol edilmedi')+'. '+active.length+' koşu sırada.</p><p>'+(cloud?'Testler GitHub Actions üzerinde çalışır. Bilgisayarınızın açık kalması gerekmez.':e(s.schedule?.installed?'Günlük '+config.schedule.dailyAt+' yerel zamanlayıcı etkin.':'Yerel zamanlayıcı durumu kurulum kaydında görünür.')+' Bilgisayarın açık ve internete bağlı olması gerekir. Testler Vercel üzerinde çalışmaz.')+'</p></section>'+
  (cloud?cloudControls:'')+
  (s.packageReview?'<div class="notice warn">'+e(s.packageReview)+'</div>':'')+
  (cloud?'':config.publish.pendingNativeLogin?'<div class="notice warn">Otomatik yayın bir defalık yerel Vercel girişini bekliyor. Günlük testler ve rapor üretimi bilgisayarda çalışır; siteye otomatik gönderim henüz etkin değil.</div>':config.publish.enabled?'<p class="muted">Otomatik Vercel yayını etkin.</p>':'<p class="muted">Otomatik yayın kapalı; raporlar yerelde üretilir.</p>')+
  (last?.errors?.length?'<details><summary>Son kontrolün erişim sorunları</summary><pre>'+e(JSON.stringify(publicCopy(last.errors),null,2))+'</pre></details>':'')+
  '<h2>Koşu geçmişi</h2>'+table(['Tarih','Sürüm ve deney','Durum','Teknik kontroller','Kayıt'],[...s.runs].reverse().map(x=>[e(date(x.startedAt)),e(x.version)+'<div class="muted">'+e(reason(x.reason))+'</div>','<span class="'+(x.status==='completed'?'':'status-warn')+'">'+e(statusNames[x.status]??x.status)+'</span>',x.summary?e(x.summary.technical.passed+'/'+x.summary.technical.total)+' geçti · '+e(x.summary.technical.failed)+' başarısız':'Henüz ölçülmedi','<a href="runs/'+e(x.id)+'/report.html">İncele</a>']),'run-history')+
  '<h2>Takip edilen beş görev</h2><div class="model-list">'+config.models.map(x=>'<article class="panel"><strong>'+e(x.slot)+' · '+e(taskLabels[x.slot])+'</strong><p>'+e(x.id)+'</p><span class="muted">'+e(x.dtype)+' · sabit başlangıç revizyonu '+e(x.revision.slice(0,12))+'</span></article>').join('')+'</div>'+
  '<h2>Yeni model adayları</h2><p>İlk tarama mevcut depoları başlangıç listesine alır. Sonradan eklenen uyumlu adaylar ve takip edilen depolardaki revizyonlar iş kuyruğuna girer. Görev, mimari, etiket, dosya veya boyut uyumsuzluğu varsa gerekçe kaydedilir.</p>'+
  (s.candidates.length?table(['Model','Ön kontrol','Açıklama'],s.candidates.slice(-30).reverse().map(x=>[e(x.id),x.eligible?'Adapter bulundu':'İnceleme gerekli',e(x.reason??('Görev '+x.slot+' · '+n(x.bytes/1024**2)+' MiB'))])):'<p>Henüz yeni aday kaydı yok.</p>')+
  '<details><summary>Yöntem ve sınırlar</summary><p>Her uygun koşu mevcut beş görev protokolünü ayrı bir klasörde çalıştırır. Yeni aday ilgili görev yuvasına yerleştirilir; diğer dört model sabit tutulur. Beklenmeyen mimariler için yeni adapter gerekir. Başarı eşikleri sonuçlara göre değiştirilmez. Ağ indirme bütçesi ve bellek sınırı aşılırsa koşu ertelenir veya eksik kaydedilir.</p><p>Otomatik ölçümler kapsamlı insan değerlendirmesinin yerini almaz. '+(cloud?'Kaydedilmiş sonuçlar GitHub results dalında saklanır; Vercel bunları gösterir. Bulut ve yerel makine süreleri doğrudan hız kıyası oluşturmaz.':'Yayın erişimi sona ererse yerel sonuçlar korunur. Vercel bu tarihli çıktıları gösterir.')+'</p></details>';
 await fs.writeFile(path.join(out,'index.html'),shell('Otomatik deneyler',content,'../styles.css',config.publish.baseUrl+'lab/'));
 await writeJSON(path.join(out,'catalog.json'),publicCopy({schemaVersion:1,generatedAt:new Date().toISOString(),lastCheck:s.lastCheck,schedule:s.schedule,latestPackage:s.latestPackage,runs:publicRuns,candidates:s.candidates.map(({files,...x})=>x),queue:active.map(({models,...x})=>x),previousPublication:s.lastPublish}));
 // Public export never includes local.json, credentials, model weights or machine logs.
 for(const file of await walk(out))if(/\.(json|html)$/.test(file)){const text=await fs.readFile(file,'utf8');if(/\b[A-Z]:[\\/]+Users[\\/]+/i.test(text))throw new Error('Personal local path found in public export');}
 return out;
}
export async function publish(s){
 const {config,local}=await settings();const source=await buildPublic(s);const deployment=path.resolve(ROOT,config.publish.deploymentDirectory);await fs.cp(source,path.join(deployment,'lab'),{recursive:true});
 if(config.cloud?.enabled)await import('./cloud/stage-vercel.mjs');
 try{
  await command(process.execPath,[local.vercelCli,'deploy','--prod','--yes',...(local.vercelGlobalConfig?['--global-config',local.vercelGlobalConfig]:[])],{cwd:deployment,log:path.join(STATE,'publish.log'),timeoutMs:10*60*1000});
  s.lastPublish={at:new Date().toISOString(),status:'completed',url:config.publish.baseUrl+'lab/'};
 }catch(error){s.lastPublish={at:new Date().toISOString(),status:'failed',message:'Vercel publication failed; local results are retained. Check the local publish log and Vercel login.'};}
 await saveState(s);return s.lastPublish;
}
