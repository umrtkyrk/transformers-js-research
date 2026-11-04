import { writeFileSync } from 'node:fs';
const started = performance.now();
const events=[];
const original=globalThis.fetch;
globalThis.fetch=async (...args)=>{
  const begin=performance.now();
  const entry={url:String(args[0]?.url??args[0]),method:args[1]?.method??'GET'};
  events.push(entry);
  try {const response=await original(...args);Object.assign(entry,{status:response.status,durationMs:performance.now()-begin,contentLength:response.headers.get('content-length'),contentType:response.headers.get('content-type')});return response;}
  catch(error){entry.error=error.message;throw error;}
};
process.on('exit',()=>{
  if(process.env.VALIDATION_TRACE_FILE)writeFileSync(process.env.VALIDATION_TRACE_FILE,JSON.stringify({timestamp:new Date().toISOString(),durationMs:performance.now()-started,fetches:events},null,2));
});
