const state = document.getElementById('model-state');
const resultArea = document.getElementById('result');
const errorArea = document.getElementById('error');
const worker = new Worker('/inference-worker.mjs', { type: 'module' });
const waiting = new Map();
let sequence = 0, rpcIssuedCount = 0, currentKey = null, busy = false, lastError = null;
let heartbeatCount = 0, probe = null;
let workerFailed = false;

function displayError(error) { lastError = { name: error.name, message: error.message, code: error.code ?? null }; errorArea.textContent = error.message; }
function controls() {
  document.getElementById('load-m1').disabled = busy;
  document.getElementById('load-m2').disabled = busy;
  document.getElementById('infer').disabled = busy || !currentKey;
  document.getElementById('dispose').disabled = busy || !currentKey;
}
function rpc(method, params = {}) {
  if (workerFailed) return Promise.reject(new Error('Worker stopped; reload the page before retrying.'));
  rpcIssuedCount++;
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      const error = new Error(`Worker RPC timeout: ${method}`); error.code = 'WORKER_TIMEOUT';
      workerFailed = true; worker.terminate();
      for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
      waiting.clear(); displayError(error);
    }, 240000);
    waiting.set(id, { resolve, reject, timer });
    worker.postMessage({ id, method, params });
  });
}
worker.addEventListener('message', ({ data }) => {
  if (data.type === 'progress') {
    const progress = data.progress;
    state.textContent = `${data.key} loading: ${progress.file ?? progress.status ?? ''}${typeof progress.progress === 'number' ? ` ${progress.progress.toFixed(1)}%` : ''}`;
    return;
  }
  const pending = waiting.get(data.id);
  if (!pending) return;
  waiting.delete(data.id);
  clearTimeout(pending.timer);
  if (data.ok) pending.resolve(data.result);
  else { const error = new Error(data.error.message); Object.assign(error, data.error); pending.reject(error); }
});
worker.addEventListener('error', event => {
  const error = new Error(event.message || 'Worker failed');
  workerFailed = true;
  displayError(error);
  for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
  waiting.clear();
});

function validate(value) {
  const inputs = Array.isArray(value) ? value : [value];
  if (!inputs.length || inputs.length > 32 || inputs.some(item => typeof item !== 'string' || !item.trim())) {
    const error = new TypeError('Provide 1 to 32 non-empty texts.');
    error.code = 'APP_INVALID_INPUT'; displayError(error); throw error;
  }
  return inputs;
}

async function load(key) {
  busy = true; currentKey = null; controls(); errorArea.textContent = ''; lastError = null;
  try {
    const loaded = await rpc('load', { key }); currentKey = key;
    state.textContent = `${key} ready · ${loaded.backend} · load ${loaded.loadMs.toFixed(1)} ms · ${loaded.id}`;
    return loaded;
  } catch (error) { displayError(error); throw error; }
  finally { busy = false; controls(); }
}

async function infer(value) {
  const inputs = validate(value);
  document.getElementById('inputs').value = inputs.join('\n');
  busy = true; controls(); errorArea.textContent = ''; lastError = null;
  try {
    const output = await rpc('infer', { inputs });
    const visible = output.embeddings ? { ...output, embeddings: output.embeddings.map(row => row.slice(0, 8)), embeddingPreview: 'First 8 values per row; complete vectors are returned to the test harness.' } : output;
    resultArea.textContent = JSON.stringify(visible, null, 2);
    return output;
  } catch (error) { displayError(error); throw error; }
  finally { busy = false; controls(); }
}

async function dispose() {
  busy = true; controls();
  try { const output = await rpc('dispose'); currentKey = null; state.textContent = 'Model disposed.'; return output; }
  finally { busy = false; controls(); }
}

function startUiProbe() { probe = { start: performance.now(), last: performance.now(), gaps: [] }; return { started: true, intervalMs: 25 }; }
function stopUiProbe() {
  if (!probe) return null;
  const values = probe.gaps.slice().sort((a,b) => a-b);
  const output = { durationMs: performance.now() - probe.start, timerIntervalMs: 25, ticks: values.length, maximumGapMs: values.length ? values.at(-1) : null, p95GapMs: values.length ? values[Math.ceil(values.length * .95) - 1] : null, gapsOver200Ms: values.filter(value => value > 200).length, note: 'Main-page timer gaps during worker inference, not a total UI usability or memory measurement.' };
  probe = null; return output;
}
setInterval(() => {
  const now = performance.now(); heartbeatCount++;
  document.getElementById('heartbeat').textContent = heartbeatCount;
  if (probe) { probe.gaps.push(now - probe.last); probe.last = now; }
}, 25);

async function probeWebGPU() {
  const output = { apiAvailable: Boolean(navigator.gpu), adapterAvailable: false, modelTested: false };
  if (!navigator.gpu) return output;
  try {
    const adapter = await navigator.gpu.requestAdapter(); output.adapterAvailable = Boolean(adapter);
    if (adapter) {
      output.info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null;
      output.features = [...adapter.features];
    }
  } catch (error) { output.error = error.message; }
  return output;
}

const ready = rpc('init').then(output => {
  document.getElementById('environment').textContent = JSON.stringify({ package: output.version, device: output.device, numThreads: output.numThreads, remoteModels: output.allowRemoteModels, browserCache: output.useBrowserCache, wasmCache: output.useWasmCache, userAgent: navigator.userAgent }, null, 2);
  state.textContent = 'Worker ready. No model loaded.'; controls(); return output;
}).catch(error => { displayError(error); throw error; });

window.validationApi = {
  ready, load, infer, dispose, startUiProbe, stopUiProbe, probeWebGPU,
  status: () => rpc('status'),
  getMetrics: () => ({ rpcIssuedCount, currentKey, busy, lastError, heartbeatCount, pendingRpcCount: waiting.size }),
};

document.getElementById('load-m1').addEventListener('click', () => load('M1').catch(() => {}));
document.getElementById('load-m2').addEventListener('click', () => load('M2').catch(() => {}));
document.getElementById('dispose').addEventListener('click', () => dispose().catch(displayError));
document.getElementById('inference-form').addEventListener('submit', event => { event.preventDefault(); infer(document.getElementById('inputs').value.split('\n')).catch(() => {}); });
window.addEventListener('pagehide', () => worker.terminate());
