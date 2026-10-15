import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AI_WORKFLOWS, runAIWorkflow } from './ai/registry.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const publicFiles = new Set(['index.html', 'app.js', 'db.js', 'progress.js', 'corrections.js', 'exercise-catalog.js', 'tracking.js', 'ai-context.js', 'ai-time.js', 'ai-api.js', 'styles.css', 'sw.js', 'manifest.webmanifest']);
let generating = false;
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Your history is too large for one AI request. Nothing was removed; contact the app maintainer to increase capacity.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error('Invalid request JSON.'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  // This personal server is deliberately local-only. Reject DNS rebinding and
  // cross-origin calls before accepting any request that can spend API credits.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Local access only.' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.headers.origin && req.headers.origin !== url.origin) return json(res, 403, { error: 'Use the app from its own address.' });
  if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, { ready: !!process.env.OPENAI_API_KEY });
  if (AI_WORKFLOWS[url.pathname]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'Use application/json.' });
    if (generating) return json(res, 429, { error: 'An AI request is already running. Please wait a moment.' });
    generating = true;
    try {
      const context = await body(req);
      const suggestion = await runAIWorkflow(url.pathname, context, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
      json(res, 200, suggestion);
    } catch (error) {
      json(res, error.status || 502, { error: error.name === 'TimeoutError' ? 'AI took too long. Please try again.' : error.status ? error.message : 'Could not reach AI. Please try again.' });
    } finally { generating = false; }
    return;
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!publicFiles.has(file) && !/^icons\/[a-zA-Z0-9_-]+\.png$/.test(file)) return json(res, 404, { error: 'Not found.' });
  try {
    const bytes = await readFile(join(root, file));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { json(res, 404, { error: 'Not found.' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Workout Tracker: http://127.0.0.1:${port} (AI ${process.env.OPENAI_API_KEY ? 'connected' : 'needs OPENAI_API_KEY'})`));
