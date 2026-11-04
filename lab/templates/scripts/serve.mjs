import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
};

function inside(base, name) {
  const resolved = path.resolve(base, name);
  const relative = path.relative(path.resolve(base), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

export async function startServer({ root = DEFAULT_ROOT, port = 0, host = '127.0.0.1' } = {}) {
  root = path.resolve(root);
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const start = performance.now();
    const record = {
      method: request.method, url: request.url, timestamp: new Date().toISOString(),
      range: request.headers.range ?? null, status: null, contentLength: null,
      bytesReadForResponse: 0, completed: false,
    };
    requests.push(record);
    response.on('finish', () => { record.completed = true; record.durationMs = performance.now() - start; });
    response.on('close', () => { record.durationMs ??= performance.now() - start; });
    const fail = (status, message) => {
      record.status = status;
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'Method not allowed');
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let target;
      if (pathname === '/' || pathname === '/app.html') target = path.join(root, 'browser', 'app.html');
      else if (pathname === '/guide.html') target = path.join(root, 'browser', 'guide.html');
      else if (pathname === '/app.mjs' || pathname === '/inference-worker.mjs') target = path.join(root, 'browser', pathname.slice(1));
      else if (pathname === '/config/model-fixtures.json') target = path.join(root, 'config', 'model-fixtures.json');
      else if (pathname === '/vendor/transformers.js') target = path.join(root, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.js');
      else if (pathname.startsWith('/models/')) target = inside(path.join(root, '.cache', 'models'), pathname.slice('/models/'.length));
      else if (pathname.startsWith('/ort/')) target = inside(path.join(root, 'node_modules', 'onnxruntime-web', 'dist'), pathname.slice('/ort/'.length));
      if (!target) return fail(404, 'Not found');
      let info;
      try { info = await stat(target); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fail(404, 'Not found'); throw error; }
      if (!info.isFile()) return fail(404, 'Not found');
      let startByte = 0, endByte = info.size - 1, status = 200;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match) return fail(416, 'Unsupported range');
        startByte = Number(match[1]);
        endByte = match[2] ? Math.min(Number(match[2]), endByte) : endByte;
        if (startByte > endByte || startByte >= info.size) return fail(416, 'Range not satisfiable');
        status = 206;
      }
      const contentLength = Math.max(0, endByte - startByte + 1);
      const headers = {
        'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': contentLength,
        'Accept-Ranges': 'bytes',
        'Cache-Control': pathname.endsWith('.html') || pathname.startsWith('/config/') ? 'no-store' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${startByte}-${endByte}/${info.size}`;
      record.status = status; record.contentLength = contentLength;
      response.writeHead(status, headers);
      if (request.method === 'HEAD' || !contentLength) return response.end();
      const stream = createReadStream(target, { start: startByte, end: endByte });
      stream.on('data', chunk => { record.bytesReadForResponse += chunk.length; });
      stream.on('error', error => { record.error = error.message; response.destroy(error); });
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      record.error = error.message;
      if (!response.headersSent) fail(error instanceof URIError ? 400 : 500, 'Request failed');
      else response.destroy(error);
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return {
    server, root, requests, host, port: address.port, baseURL: `http://${host}:${address.port}`,
    close: async () => {
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startServer({ port: Number(process.env.PORT ?? 8000) });
  console.log(JSON.stringify({ event: 'server-ready', baseURL: running.baseURL }));
  const shutdown = () => running.close().finally(() => process.exit());
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
