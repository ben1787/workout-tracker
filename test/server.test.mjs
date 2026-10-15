import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

// Run the actual server, without credentials or a network dependency.
test('local server protects credentials, rejects cross-origin calls and reports setup state', async t => {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PORT: String(port) }; delete env.OPENAI_API_KEY;
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill());
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server exited'); })]);
  const url = `http://127.0.0.1:${port}`;
  const status = await fetch(`${url}/api/status`);
  assert.deepEqual(await status.json(), { ready: false });
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Workout Tracker/);
  for (const path of ['/.env', '/server.mjs', '/ai.mjs', '/test/ai.test.mjs', '/package.json']) assert.equal((await fetch(url + path)).status, 404);
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goals: [{ title: 'Strength', details: '' }], history: [], today: { minutes: 30, equipment: '', limitations: '', feeling: '' } }) };
  const missingKey = await fetch(`${url}/api/workout`, request);
  assert.equal(missingKey.status, 503);
  assert.match((await missingKey.json()).error, /OPENAI_API_KEY/);
  const reviewRequest = await fetch(`${url}/api/progress`, { ...request, body: JSON.stringify({ completedWorkoutId: 'done', goals: [], history: [{ id: 'done', startedAt: 100, endedAt: 200, sections: [], day: { type: 'rest' } }] }) });
  assert.equal(reviewRequest.status, 503);
  const invalidReview = await fetch(`${url}/api/progress`, { ...request, body: JSON.stringify({ goals: [], history: [] }) });
  assert.equal(invalidReview.status, 400);
  const crossOrigin = await fetch(`${url}/api/workout`, { ...request, headers: { ...request.headers, Origin: 'https://unrelated.example' } });
  assert.equal(crossOrigin.status, 403);
  const badBody = await fetch(`${url}/api/workout`, { ...request, body: '{' });
  assert.equal(badBody.status, 400);
  const badGoals = await fetch(`${url}/api/workout`, { ...request, body: JSON.stringify({ goals: [], history: [] }) });
  assert.equal(badGoals.status, 400);
});
