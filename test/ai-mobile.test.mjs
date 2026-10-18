import test from 'node:test';
import assert from 'node:assert/strict';
import {requestAI} from '../ai-api.js';
test('mobile interruptions retry the same job and recover its result',async()=>{
 let posts=0,polls=0;const ids=[];const expected={workout:{day_name:'Recovered'}};
 const result=await requestAI('workout',{}, {pause:async()=>{},fetchImpl:async(url,options)=>{
   if(options.method==='POST') {posts++;ids.push(options.headers['X-AI-Request-ID']);assert.equal(options.headers.Prefer,'respond-async');if(posts===1)throw new DOMException('Fetch aborted','AbortError');return Response.json({jobId:'job'});}
   polls++;assert.equal(url,'/api/ai-jobs/job');if(polls===1)throw new DOMException('Fetch aborted','AbortError');return Response.json({state:'completed',result:expected});
 }});
 assert.deepEqual(result,expected);assert.equal(posts,2);assert.equal(polls,2);assert.equal(ids[0],ids[1]);
});
test('a failed job surfaces the real error instead of retrying generation',async()=>{
 let posts=0;
 await assert.rejects(requestAI('workout',{}, {pause:async()=>{},fetchImpl:async(url,options)=>{
   if(options.method==='POST'){posts++;return Response.json({jobId:'job'});}
   return Response.json({state:'failed',error:'AI took too long. Please try again.'});
 }}), /AI took too long/);
 assert.equal(posts,1);
});
