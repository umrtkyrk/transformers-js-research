import fs from 'node:fs/promises';
import path from 'node:path';
import {WORK,ROOT,exists,walk,hashFile} from '../core.mjs';
const deployment=path.join(WORK,'vercel-deploy');
// Vercel serves real static files before applying a fallback rewrite. Keep the
// preserved local reports under a different directory so /lab can serve cloud data.
const legacy=path.resolve(deployment,'lab'),archive=path.resolve(deployment,'archive-lab');
if(path.relative(deployment,legacy)!=='lab'||path.relative(deployment,archive)!=='archive-lab')throw new Error('Archive paths escaped the deployment');
if(await exists(legacy)){
 if(!(await exists(archive)))await fs.rename(legacy,archive);
 else {
  await fs.cp(legacy,archive,{recursive:true});
  for(const file of await walk(legacy))if(await hashFile(file)!==await hashFile(path.join(archive,path.relative(legacy,file))))throw new Error('Archive copy mismatch');
  await fs.rm(legacy,{recursive:true});
 }
}
for(const directory of ['api','server'])await fs.mkdir(path.join(deployment,directory),{recursive:true});
for(const [source,target] of [
 ['server.mjs','server/research.mjs'],
 ['vercel-api-check.mjs','api/research-check.mjs'],
 ['vercel-api-artifact.mjs','api/research-artifact.mjs'],
 ['client.js','lab-cloud-client.js'],
 ['vercel.json','vercel.json']
])await fs.copyFile(path.join(ROOT,'cloud',source),path.join(deployment,target));
// The public UI client also stays with the ordinary static source for later exports.
await fs.copyFile(path.join(ROOT,'cloud/client.js'),path.join(WORK,'research-portal/dist/lab-cloud-client.js'));
await fs.writeFile(path.join(deployment,'package.json'),JSON.stringify({name:'transformers-research-site',private:true,type:'module',engines:{node:'24.x'}},null,2));
console.log(JSON.stringify({staged:true,repository:'umrtkyrk/transformers-js-research',requiredEnvironment:'LAB_GITHUB_TOKEN'}));
