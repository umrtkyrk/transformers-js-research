import fs from 'node:fs/promises';
import path from 'node:path';
import {artifactHandler} from '../server/research.mjs';
export default (req,res)=>artifactHandler(req,res,{readFallback:relative=>fs.readFile(path.join(process.cwd(),'archive-lab',relative))});
