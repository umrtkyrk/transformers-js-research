import { env, pipeline } from '/vendor/transformers.js';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = '/models/';
env.useFSCache = false;
env.useBrowserCache = true;
env.useWasmCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', self.location.href).href,
  wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', self.location.href).href,
};

let fixtures;
let active = null;
let currentFixture = null;
let inferenceCount = 0;
let serial = Promise.resolve();
const errorData = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code ?? null, stack: error?.stack ?? null });

function inputsOf(value) {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || items.length > 32 || items.some(item => typeof item !== 'string' || !item.trim())) {
    const error = new TypeError('Application input must contain 1 to 32 non-empty strings');
    error.code = 'APP_INVALID_INPUT'; throw error;
  }
  return items;
}

async function dispose() {
  if (active) await active.dispose();
  active = null; currentFixture = null;
  return { disposed: true };
}

async function dispatch(method, params = {}) {
  if (method === 'init') {
    fixtures ??= await fetch('/config/model-fixtures.json', { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`Fixture manifest HTTP ${response.status}`);
      return response.json();
    });
    return { version: env.version, device: 'wasm', dtype: 'q8', numThreads: env.backends.onnx.wasm.numThreads, allowLocalModels: env.allowLocalModels, allowRemoteModels: env.allowRemoteModels, useBrowserCache: env.useBrowserCache, useWasmCache: env.useWasmCache, wasmPaths: env.backends.onnx.wasm.wasmPaths, fixtures };
  }
  if (method === 'status') return { ready: Boolean(active), key: currentFixture?.key ?? null, inferenceCount };
  if (method === 'dispose') return dispose();
  if (method === 'load') {
    if (!fixtures) await dispatch('init');
    const fixture = fixtures.models.find(item => item.key === params.key);
    if (!fixture) throw new Error(`Unknown fixture key: ${params.key}`);
    await dispose();
    const start = performance.now();
    active = await pipeline(fixture.task, fixture.id, {
      revision: fixture.revision, dtype: fixture.dtype, device: 'wasm', local_files_only: true,
      progress_callback: progress => self.postMessage({ type: 'progress', key: fixture.key, progress }),
    });
    currentFixture = fixture;
    return { key: fixture.key, id: fixture.id, revision: fixture.revision, task: fixture.task, dtype: fixture.dtype, backend: 'wasm', numThreads: 1, loadMs: performance.now() - start };
  }
  if (method === 'infer') {
    const inputs = inputsOf(params.inputs);
    if (!active) { const error = new Error('Load a model before inference'); error.code = 'MODEL_NOT_READY'; throw error; }
    const start = performance.now();
    const output = currentFixture.task === 'feature-extraction'
      ? await active(inputs, { pooling: 'mean', normalize: true })
      : await active(inputs);
    const elapsedMs = performance.now() - start;
    inferenceCount++;
    if (currentFixture.task === 'feature-extraction') {
      const embeddings = output.tolist();
      return { key: currentFixture.key, task: currentFixture.task, inputCount: inputs.length, elapsedMs, dims: output.dims, embeddings, norms: embeddings.map(row => Math.sqrt(row.reduce((sum, value) => sum + value * value, 0))) };
    }
    return { key: currentFixture.key, task: currentFixture.task, inputCount: inputs.length, elapsedMs, outputs: output };
  }
  throw new Error(`Unknown worker RPC: ${method}`);
}

self.addEventListener('message', ({ data }) => {
  serial = serial.then(async () => {
    try { self.postMessage({ id: data.id, ok: true, result: await dispatch(data.method, data.params) }); }
    catch (error) { self.postMessage({ id: data.id, ok: false, error: errorData(error) }); }
  }).catch(error => self.postMessage({ type: 'worker-error', error: errorData(error) }));
});
