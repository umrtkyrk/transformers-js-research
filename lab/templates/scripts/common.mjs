import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RESULTS = path.join(ROOT, 'results', process.env.VALIDATION_RUN_ID ?? '');
export const config = JSON.parse(await readFile(path.join(ROOT, 'config', 'model-fixtures.json'), 'utf8'));
await mkdir(RESULTS, { recursive: true });
export async function save(name, value) { await writeFile(path.join(RESULTS, name), JSON.stringify(value, null, 2)); }
export async function progress(event, details = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...details };
  console.log(JSON.stringify(entry));
  await appendFile(path.join(RESULTS, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
}
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function dot(a, b) { let n = 0; for (let i = 0; i < a.length; i++) n += a[i] * b[i]; return n; }
export function norm(a) { return Math.sqrt(dot(a, a)); }
export function quantile(values, q) { const a = [...values].sort((x,y) => x-y); return a[Math.max(0, Math.ceil(q*a.length)-1)]; }
export function statistics(values) { return { count: values.length, median: quantile(values, .5), p95: quantile(values, .95), minimum: Math.min(...values), maximum: Math.max(...values), mean: values.reduce((a,b)=>a+b,0)/values.length }; }
export function memory() { return { ...process.memoryUsage(), availableSystemBytes: os.freemem() }; }
export async function measured(fn) {
  const before = memory();
  let sampledMaxRss = before.rss, samples = 1;
  const timer = setInterval(() => { sampledMaxRss = Math.max(sampledMaxRss, process.memoryUsage().rss); samples++; }, 25);
  const start = performance.now();
  try {
    const value = await fn();
    const after = memory();
    sampledMaxRss = Math.max(sampledMaxRss, after.rss);
    return { value, durationMs: performance.now()-start, memory: { before, after, sampledMaxRssBytes: sampledMaxRss, samplingIntervalMs: 25, samples, note: 'Whole process RSS sampled on the same event loop; short native peaks may be missed. This is not model-only RAM or GPU memory.' } };
  } finally { clearInterval(timer); }
}
export async function loadLibrary() {
  const imported = await measured(() => import('@huggingface/transformers'));
  const { env, pipeline } = imported.value;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.join(ROOT, '.cache', 'models') + path.sep;
  env.useFSCache = false;
  env.useBrowserCache = false;
  return { ...imported.value, env, pipeline, importMeasurement: { durationMs: imported.durationMs, memory: imported.memory } };
}
export async function loadFixture(pipeline, key) {
  const fixture = config.models.find(model => model.key === key);
  return measured(() => pipeline(fixture.task, fixture.id, {
    revision: fixture.revision,
    local_files_only: true,
    device: 'cpu',
    dtype: fixture.dtype,
    session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
  }));
}
export function validateInputs(value, maximumBatch = 32) {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || items.length > maximumBatch) throw new Error('Batch size outside application limits');
  for (const item of items) if (typeof item !== 'string' || !item.trim()) throw new Error('Each input must be a non-empty string');
  return items;
}
