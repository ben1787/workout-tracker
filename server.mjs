import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createCloudStore } from './cloud-store.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AI_WORKFLOWS, runAIWorkflow } from './ai/registry.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const publicFiles = new Set(['index.html', 'app.js', 'db.js', 'progress.js', 'corrections.js', 'exercise-catalog.js', 'tracking.js', 'cloud.js', 'ai-context.js', 'ai-time.js', 'ai-api.js', 'styles.css', 'sw.js', 'manifest.webmanifest']);
const cloud = process.env.DATABASE_URL ? createCloudStore(process.env.DATABASE_URL, {secure: process.env.PUBLIC_ORIGIN?.startsWith('https://') !== false}) : null;
if (process.env.RENDER && !cloud) throw new Error('DATABASE_URL is required on Render.');
if (cloud && !process.env.PUBLIC_ORIGIN && !process.env.RENDER_EXTERNAL_URL) throw new Error('PUBLIC_ORIGIN is required for hosted access.');
const publicOrigin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
const loginAttempts = new Map();
function rateLimit(req) {
  const ip = process.env.RENDER ? String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : req.socket.remoteAddress;
  const key = ip || 'unknown';
  const current = loginAttempts.get(key);
  if (!current || current.until < Date.now()) loginAttempts.set(key,{count:1,until:Date.now()+15*60000});
  else if (++current.count > 12) throw Object.assign(new Error('Too many login attempts. Try again in 15 minutes.'),{status:429});
  if(loginAttempts.size>10000) for(const [key,value] of loginAttempts) if(value.until<Date.now()) loginAttempts.delete(key);
}
let generating = false;
const aiJobs = new Map();
const jobOwner = user => user?.id || 'local';
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
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const allowedOrigin = cloud ? publicOrigin : `http://${req.headers.host}`;
  if (cloud ? req.headers.host !== new URL(publicOrigin).host : !new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(req.headers.host)) return json(res,403,{error:'Use the app from its own address.'});
  const url = new URL(req.url,allowedOrigin);
  if (req.headers.origin && req.headers.origin !== allowedOrigin) return json(res,403,{error:'Use the app from its own address.'});
  if(cloud && !['GET','HEAD'].includes(req.method) && req.headers.origin!==allowedOrigin) return json(res,403,{error:'A same-origin request is required.'});
  if(url.pathname==='/api/health' && req.method==='GET') {try {if(cloud) await cloud.health(); return json(res,200,{ok:true});} catch {return json(res,503,{error:'Storage unavailable.'});}}
  let user=null;
  if(cloud && url.pathname.startsWith('/api/')) {
    try {
      user=await cloud.authenticate(req);
      if(url.pathname==='/api/auth/session' && req.method==='GET') return json(res,200,{cloud:true,user,setupRequired:!await cloud.isSetup()});
      if(['/api/auth/login','/api/auth/register'].includes(url.pathname) && req.method==='POST') {
        rateLimit(req);
        if(req.headers['content-type']!=='application/json') return json(res,415,{error:'Use application/json.'});
        const result=await cloud[url.pathname.endsWith('register')?'register':'login'](await body(req));
        res.setHeader('Set-Cookie',result.cookie); return json(res,200,{user:result.user});
      }
      if(url.pathname==='/api/auth/bootstrap' && req.method==='POST') {rateLimit(req); return json(res,200,await cloud.bootstrap(await body(req)));}
      if(!user) return json(res,401,{error:'Please sign in to continue.'});
      if(url.pathname==='/api/auth/logout' && req.method==='POST') {res.setHeader('Set-Cookie',await cloud.logout(req)); return json(res,200,{ok:true});}
      if(url.pathname==='/api/data/import' && req.method==='POST') return json(res,200,await cloud.import(user,await body(req)));
      const match=/^\/api\/data\/(plans|workouts|goals|exercises)(?:\/(.+))?$/.exec(url.pathname);
      if(match) {
        const [,kind,encodedId]=match; const id=encodedId?decodeURIComponent(encodedId):null;
        if(req.method==='GET') return json(res,200,await cloud.list(user,kind,id));
        if(req.method==='PUT' && !id) {const {record,expectedResultsRevision}=await body(req); return json(res,200,await cloud.save(user,kind,record,expectedResultsRevision));}
        if(req.method==='DELETE' && id) return json(res,200,await cloud.remove(user,kind,id,Number(req.headers['if-match'])));
        return json(res,405,{error:'Method not allowed.'});
      }
    } catch(error) {return json(res,error.status || 503,{error:error.status?error.message:'Storage is temporarily unavailable. Please try again.'});}
  }
  if(!cloud && url.pathname==='/api/auth/session') return json(res,200,{cloud:false,user:null});
  if (url.pathname.startsWith('/api/ai-jobs/') && req.method === 'GET') {
    const job = aiJobs.get(url.pathname.slice('/api/ai-jobs/'.length));
    if (!job || job.owner !== jobOwner(user) || job.expiresAt < Date.now()) return json(res,404,{error:'This AI request has expired. Please generate the workout again.'});
    return json(res,200,{jobId:job.id,state:job.state,...(job.state === 'completed' ? {result:job.result} : job.state === 'failed' ? {error:job.error,status:job.status} : {})});
  }
  if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, { ready: !!process.env.OPENAI_API_KEY });
  if (AI_WORKFLOWS[url.pathname]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'Use application/json.' });
    const asyncRequest = req.headers.prefer === 'respond-async';
    const suppliedId = String(req.headers['x-ai-request-id'] || '');
    const requestId = asyncRequest && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : randomUUID();
    for (const [id,job] of aiJobs) if (job.expiresAt < Date.now()) aiJobs.delete(id);
    const existingJob = aiJobs.get(requestId);
    if (asyncRequest && existingJob) {
      if (existingJob.owner !== jobOwner(user) || existingJob.path !== url.pathname) return json(res,404,{error:'AI request not found.'});
      return json(res,202,{jobId:requestId});
    }
    const started = Date.now();
    const diagnostics = { stage: 'input_validation' };
    res.setHeader('X-Request-ID', requestId);
    const log = (event, extra = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, requestId, workflow: AI_WORKFLOWS[url.pathname].name, model: process.env.OPENAI_MODEL || 'gpt-6.1-sol', durationMs: Date.now()-started, ...diagnostics, ...extra }));
    if (generating) { log('ai_rejected', {status:429, failure:'busy'}); return json(res, 429, { error: 'An AI request is already running. Please wait a moment.', requestId }); }
    log('ai_started');
    res.on('close', () => { if (!res.writableFinished) log('ai_client_disconnected'); });
    generating = true;
    let context;
    try { context = await body(req); }
    catch(error) { generating=false; log('ai_failed',{status:error.status || 400}); return json(res,error.status || 400,{error:error.message,requestId}); }
    let job;
    if (asyncRequest) {
      while(aiJobs.size >= 20) aiJobs.delete(aiJobs.keys().next().value);
      job = {id:requestId,owner:jobOwner(user),path:url.pathname,state:'running',expiresAt:Date.now()+20*60*1000};
      aiJobs.set(requestId,job);
      json(res,202,{jobId:requestId});
    }
    const run = async () => {
      try {
        const suggestion = await runAIWorkflow(url.pathname, context, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, diagnostics });
        if (cloud && Array.isArray(suggestion.catalogUpdates)) {
          const catalogStarted=Date.now();
          try {
            await cloud.saveGeneratedExercises(user,suggestion.catalogUpdates);
            suggestion.exerciseCatalog=await cloud.list(user,'exercises');
            suggestion.catalogUpdates=[];
          } catch { log('ai_catalog_sync_failed',{status:503}); }
          diagnostics.catalogSyncMs=Date.now()-catalogStarted;
        }
        log('ai_completed', {status:200});
        if (job) {job.state='completed';job.result=suggestion;} else json(res,200,suggestion);
      } catch(error) {
        const status=error.status || 502;
        const message=error.name === 'TimeoutError' ? 'AI took too long. Please try again.' : error.status ? error.message : 'Could not reach AI. Please try again.';
        log('ai_failed',{status});
        if (job) {job.state='failed';job.error=message;job.status=status;} else json(res,status,{error:message,requestId});
      } finally {generating=false;}
    };
    if (job) void run(); else await run();
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
if (cloud) await cloud.ready;
server.listen(port, cloud ? '0.0.0.0' : '127.0.0.1', () => console.log(`Workout Tracker: http://127.0.0.1:${port} (AI ${process.env.OPENAI_API_KEY ? 'connected' : 'needs OPENAI_API_KEY'})`));

process.on('SIGTERM',()=>server.close(async()=>{if(cloud) await cloud.close(); process.exit(0);}));
