import test from 'node:test';
import assert from 'node:assert/strict';
import { createExercise, exerciseIdentity, linkExerciseRecords, resolveGeneratedExercises } from '../exercise-catalog.js';
import { exerciseProgress, exerciseAtLoad } from '../progress.js';
import { trackingFor, trackingResult, validateTracking } from '../tracking.js';

const technique = 'Sit tall on a stable bench. Brace the torso, lift both feet, breathe, and lower them under control.';
const workout = sections => ({ id: 'one', day: {name: 'Mixed'}, startedAt: 1000, endedAt: 2000, sections });
test('catalog migration is repeatable and preserves logged measurements and dates', () => {
  const source = workout([{type:'exercise', exerciseName:'Pull-ups', reps:10, completedSets:[{reps:4,weight:20,startedAt:1100,endedAt:1200}]}, {type:'circuit', exercises:[{name:'Wall-facing handstand – 20 seconds',reps:0}], completedRounds:[{exercises:[{name:'Wall-facing handstand – 20 seconds',reps:0,weight:0}]}]}]);
  const result = linkExerciseRecords({workouts:[source]});
  assert.equal(result.workouts[0].startedAt,1000);
  assert.deepEqual(result.workouts[0].sections[0].completedSets[0], {...source.sections[0].completedSets[0],exerciseId:exerciseIdentity('Pull-up')});
  assert.equal(result.workouts[0].sections[1].exercises[0].holdSeconds,20);
  assert.equal(result.workouts[0].sections[1].completedRounds[0].exercises[0].holdSeconds,undefined);
  assert.deepEqual(linkExerciseRecords(result),result);
  assert.equal(exerciseIdentity('pull ups'),exerciseIdentity('Pull-up'));
  assert.notEqual(exerciseIdentity('Strict pull-up'),exerciseIdentity('Pull-up'));
});
test('generation reuses catalog IDs, explicitly creates missing definitions, rejects fabricated IDs', () => {
  const known = createExercise({name:'Pull-up',instructions:technique});
  const data = {newExercises:[{name:'Seated tuck hold',instructions:technique,measurement:'hold'}],workout:{sections:[{type:'circuit',exercises:[{exercise_id:known.id,name:'Pull-ups'},{exercise_id:'',name:'Seated tuck hold'}]}]}};
  const resolved = resolveGeneratedExercises(data,[known]);
  assert.equal(resolved.catalogUpdates.length,1);
  assert.equal(resolved.workout.sections[0].exercises[0].name,'Pull-up');
  assert.equal(resolved.workout.sections[0].exercises[1].exercise_id,resolved.catalogUpdates[0].id);
  data.workout.sections[0].exercises[0].exercise_id='fake';
  assert.throws(()=>resolveGeneratedExercises(data,[known]));
  data.newExercises[0].instructions='Do it';
  assert.throws(()=>resolveGeneratedExercises(data,[known]));
});
test('load comparisons use matching sets, retain order and never turn targets into actual holds', () => {
  const w=workout([{type:'exercise',exerciseId:'pull',exerciseName:'Pull-up',completedSets:[{reps:8,weight:0},{reps:3,weight:20}]},{type:'circuit',completedRounds:[{exercises:[{name:'Alias',exerciseId:'pull',reps:2,weight:20},{name:'Hold',exerciseId:'hold',completed:true,trackingValues:{}},{name:'Skipped',exerciseId:'skip',skipped:true,reps:10}]}]}]);
  const progress=exerciseProgress([w],[{id:'pull',name:'Pull-up',measurement:'reps'}]);
  const entry=progress.find(e=>e.exerciseId==='pull').entries[0];
  assert.equal(exerciseAtLoad(entry,'20').bestSetReps,3);
  assert.equal(exerciseAtLoad(entry,'20').reps,5);
  assert.deepEqual(exerciseAtLoad(entry,'20').positions,[1,2]);
  assert.deepEqual(entry.formats,['sets','circuit']);
  const hold=progress.find(e=>e.exerciseId==='hold').entries[0];
  assert.equal(hold.holdSeconds,null); assert.equal(hold.reps,null); assert.equal(hold.weight,null);
  assert.equal(progress.some(e=>e.exerciseId==='skip'),false);
});
test('completion only and blank measurements remain unmeasured; flexible fields preserve labels and units', () => {
  assert.deepEqual(trackingFor({type:'warmup',duration_minutes:6}).fields,[]);
  assert.deepEqual(trackingFor({holdSeconds:20,reps:0}).fields,[]);
  assert.deepEqual(trackingResult({fields:[]},{}),{completed:true,trackingValues:{}});
  const tracking={fields:[{key:'holdSeconds',label:'Actual hold',unit:'seconds',type:'number'},{key:'quality',label:'Technique',unit:'',type:'text'}]};
  assert.equal(trackingResult(tracking,{holdSeconds:''}).holdSeconds,undefined);
  const result=trackingResult(tracking,{holdSeconds:'12',quality:'Steady'});
  assert.equal(result.holdSeconds,12); assert.equal(result.trackingValues.quality.value,'Steady');
  assert.throws(()=>trackingResult(tracking,{holdSeconds:'-1'}));
  assert.throws(()=>validateTracking({fields:[{key:'__proto__',label:'bad',unit:'',type:'text'}]}));
});

test('catalog normalization retains the cloud revision for safe metadata saves',()=>{
 const normalized=createExercise({name:'Squat',instructions:'Keep heels down.',measurement:'reps',_serverRevision:7});
 assert.equal(normalized._serverRevision,7);
});
