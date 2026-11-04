import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(root,'.state'),{recursive:true});
// Core unit checks only require settings to exist, not developer-specific paths.
await fs.writeFile(path.join(root,'local.json'),JSON.stringify({playwrightRoot:path.resolve('.ci-tools/node_modules/playwright')}));
const assets=JSON.parse(await fs.readFile(path.join(root,'fixture-assets.json'),'utf8'));
for(const asset of assets){
 if(!/^audio\/[\w.-]+\.wav$/.test(asset.path)||!asset.url.startsWith('https://transformers-js-research.vercel.app/files/validation/data/audio/'))throw new Error('Invalid fixture source');
 const response=await fetch(asset.url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Fixture unavailable: '+asset.path);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('Fixture checksum differs: '+asset.path);
 const target=path.join(root,'fixtures',asset.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
}
console.log(JSON.stringify({verifiedAudioFixtures:assets.length}));
