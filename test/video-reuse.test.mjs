import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestWorkout} from '../ai/workout.mjs';
import {createExercise, resolveGeneratedExercises,linkExerciseRecords} from '../exercise-catalog.js';
const video='https://www.youtube.com/watch?v=abcdefghijk';
const known=createExercise({name:'Squat',instructions:'Bend your knees and hips, then stand with heels down.',youtubeUrl:video});
const context={goals:[{title:'Strength',details:''}],history:[],today:{minutes:10,equipment:'',limitations:'',feeling:''},exerciseCatalog:[known]};
const output={rationale:'Build strength.',message:'',newExercises:[],workout:{day_name:'Strength',summary:'Simple strength.',notes:'Go slowly.',type:'workout',sections:[{section_name:'Squat',type:'exercise',exercise_id:'',youtube_url:'',instructions:'Stand tall after each rep.',why:'Build strength.',rounds:0,sets:2,duration_minutes:0,distance_miles:0,interval_seconds:0,target_intensity:'',exercises:[{name:'Squat',exercise_id:known.id,youtube_url:'',reps:5,weight:0,instructions:'Bend your knees and hips, then stand with heels down.'}]}]}};
const reply=(data,sources=[])=>new Response(JSON.stringify({status:'completed',output:[...(sources.length?[{type:'web_search_call',action:{sources:sources.map(url=>({url}))}}]:[]),{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]}));
test('saved demonstrations survive catalog round trips and bypass search entirely',async()=>{
 const diagnostics={};let calls=0;
 const result=await suggestWorkout(context,{apiKey:'test',diagnostics,fetchImpl:async(url,options)=>{calls++;assert.equal(JSON.parse(options.body).tools,undefined);return reply(output);}});
 assert.equal(calls,1);assert.equal(result.workout.sections[0].exercises[0].youtube_url,video);assert.equal(result.catalogUpdates.length,0);assert.equal(diagnostics.videosReused,1);assert.equal(diagnostics.videosSearched,0);
 const linked=linkExerciseRecords({exercises:[JSON.parse(JSON.stringify(known))]});assert.equal(linked.exercises[0].youtubeUrl,video);
});
test('existing movement without a video gets one sourced lookup and a reusable catalog update',async()=>{
 let searches=0;const uncached={...known};delete uncached.youtubeUrl;
 const result=await suggestWorkout({...context,exerciseCatalog:[uncached]},{apiKey:'test',fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);if(!body.tools)return reply(output);searches++;assert.deepEqual(JSON.parse(body.input),['Squat']);return reply({videos:[{name:'Squat',youtube_url:video}]},[video]);}});
 assert.equal(searches,1);assert.equal(result.catalogUpdates[0].youtubeUrl,video);
 const next=resolveGeneratedExercises(result,[createExercise(JSON.parse(JSON.stringify(result.catalogUpdates[0])))]);assert.equal(next.catalogUpdates.length,0);
});

test('compact generation restores catalog technique and unused fields without another model call',async()=>{
 const compact=structuredClone(output);
 const section=compact.workout.sections[0];
 for(const key of ['rounds','duration_minutes','distance_miles','interval_seconds','target_intensity','exercise_id','youtube_url']) delete section[key];
 delete section.exercises[0].instructions;delete section.exercises[0].youtube_url;
 const diagnostics={};
 const result=await suggestWorkout(context,{apiKey:'test',diagnostics,fetchImpl:async(url,options)=>{
   const body=JSON.parse(options.body);
   assert.equal(body.reasoning.effort,'low');assert.equal(body.text.verbosity,'low');
   assert.equal(body.text.format.schema.properties.workout.properties.sections.items.anyOf.length,3);
   return reply(compact);
 }});
 assert.equal(result.workout.sections[0].exercises[0].instructions,known.instructions);
 assert.equal(result.workout.sections[0].rounds,0);
 assert.equal(result.workout.sections[0].exercises[0].youtube_url,video);
 assert.equal(diagnostics.calls.length,1);
});
