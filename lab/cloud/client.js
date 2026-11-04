(() => {
 const button=document.querySelector('#check-release');
 const status=document.querySelector('#cloud-status');
 const link=document.querySelector('#cloud-run-link');
 if(!button||!status||!link)return;
 let timer,wasRunning=false;
 const messages={
  'up-to-date':'Sonuçlar güncel. En yeni kararlı sürüm test edilmiş.',
  'new-version':'Yeni kararlı sürüm bulundu.',
  'queued':'Yeni sürüm bulundu. Testler GitHub Actions sırasında.',
  'running':'Testler GitHub Actions üzerinde çalışıyor. Bu sayfayı kapatabilirsiniz.',
  'needs-review':'Yeni ana sürüm için test uyarlaması gerekiyor.',
  'failed':'Son bulut çalışması tamamlanamadı. Ayrıntılar GitHub kaydında; mevcut sonuçlar korunuyor.',
  'unavailable':'Durum bilgisine şu anda erişilemiyor.'
 };
 async function check(start=false){
  clearTimeout(timer);button.disabled=true;
  status.textContent=start?'Sürüm ve mevcut testler kontrol ediliyor…':'Çalışma durumu kontrol ediliyor…';
  try{
   const response=await fetch('/api/research-check',{method:start?'POST':'GET',cache:'no-store'});
   const result=await response.json();
   status.textContent=(result.error||messages[result.status]||'Durum bilinmiyor.')+(result.latest?' Sürüm: '+result.latest+'.':'');
   const active=['running','queued'].includes(result.status);
   if(result.run?.url?.startsWith('https://github.com/umrtkyrk/transformers-js-research/actions/runs/')){link.href=result.run.url;link.hidden=false;}else link.hidden=true;
   if(active){wasRunning=true;timer=setTimeout(()=>check(),15000);}
   else if(wasRunning&&result.status==='up-to-date'){location.reload();return;}
   button.disabled=active;
  }catch{status.textContent='Bağlantı kurulamadı. Yeniden deneyebilirsiniz.';button.disabled=false;}
 }
 button.addEventListener('click',()=>check(true));
})();
