import test from 'node:test';
import assert from 'node:assert/strict';
import {runAIWorkflow} from '../ai/registry.mjs';
import {buildAIContext} from '../ai-context.js';
test('chat receives full context and conversation but returns only a reply',async()=>{
 const state={goals:[{id:'g',title:'Strength',details:'',active:true}],workouts:[{id:'w',day:{name:'Past'},sections:[],startedAt:1,endedAt:2}],exercises:[],today:{minutes:30},draft:{day:{name:'Current',sections:[]},rationale:'Balance',conversation:[{role:'user',content:'Can we make it harder?'},{role:'assistant',content:'We can discuss that.'}]}};
 const before=structuredClone(state);
 const context=buildAIContext({workflow:'chat',state,request:'Why squats?',now:new Date('2026-10-20T12:00:00Z'),timeZone:'Asia/Jerusalem'});
 const reply=await runAIWorkflow('/api/workout-chat',context,{apiKey:'test',fetchImpl:async(url,options)=>{
   const body=JSON.parse(options.body);const input=JSON.parse(body.input);
   assert.equal(input.history.length,1);assert.equal(input.currentWorkout.workout.name,'Current');assert.deepEqual(input.conversation,state.draft.conversation);assert.equal(input.request,'Why squats?');
   assert.match(body.instructions,/cannot change the workout/);
   return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({message:'Squats support your strength goal.',workout:{name:'Unwanted replacement'}})}]}]});
 }});
 assert.deepEqual(reply,{message:'Squats support your strength goal.'});assert.deepEqual(state,before);
});
test('chat rejects missing workout or malformed conversation',async()=>{
 await assert.rejects(runAIWorkflow('/api/workout-chat',{workflow:'chat',history:[],request:'Hello',conversation:[]}),error=>error.status===400);
});
