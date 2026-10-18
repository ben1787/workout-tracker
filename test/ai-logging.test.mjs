import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredResponse } from '../ai/client.mjs';

test('provider diagnostics retain correlation and failure metadata without content', async () => {
  const diagnostics = {};
  await assert.rejects(structuredResponse({input:'private workout'}, {
    apiKey:'secret', diagnostics,
    fetchImpl:async()=>new Response(JSON.stringify({status:'incomplete', incomplete_details:{reason:'max_output_tokens'},output:[]}),{headers:{'x-request-id':'req_test'}}),
  }));
  assert.deepEqual(diagnostics,{stage:'provider_response',providerStatus:200,providerRequestId:'req_test',responseStatus:'incomplete',incompleteReason:'max_output_tokens',searchCalls:0});
  assert.ok(!JSON.stringify(diagnostics).includes('private'));
  const timedOut = {};
  await assert.rejects(structuredResponse({}, {apiKey:'secret',diagnostics:timedOut,fetchImpl:async()=>{throw new DOMException('private detail','TimeoutError');}}));
  assert.equal(timedOut.failure,'timeout');
  assert.ok(!JSON.stringify(timedOut).includes('private detail'));
});
