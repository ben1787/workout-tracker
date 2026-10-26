import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../app.js',import.meta.url),'utf8');
test('positive rest pauses sets while zero rest continues immediately',()=>{
 const action=source.slice(source.indexOf('function completeExerciseSet('),source.indexOf('\nfunction startCardio('));
 for(const rest of [0,60]) {
  const sec={sets:3,completedSets:[],currentSetStartedAt:100,rest_seconds:rest};
  const context={state:{active:{sections:[sec]}},now:()=>1000,saveActive(){},maybeAdvanceSection(){},render(){}};
  vm.runInNewContext(action+';completeExerciseSet(0,{reps:5})',context);
  assert.equal(sec.completedSets.length,1);assert.equal(sec.currentSetStartedAt,rest?null:1000);
  if(rest)assert.equal(sec.restEndsAt,61000);
 }
});
test('expired rest does not start a set until an explicit tap, including after restoring a session',()=>{
 const code=source.slice(source.indexOf('const restTickers = new Map();'),source.indexOf('// Reads the in-progress'));
 const sec={type:'exercise',restEndsAt:1000};const nodes=new Map();
 const context={state:{active:{sections:[sec]}},now:()=>2000,fmtDuration:()=>'',el:(tag,attrs,children)=>{const node={textContent:children};if(attrs.id)nodes.set(attrs.id,node);return node;},document:{getElementById:id=>nodes.get(id)},setInterval:()=>1,clearInterval(){},playBeep(){},buzz(){},saveActive(){},render(){}};
 vm.runInNewContext(code+';renderRest({appendChild(){}},state.active.sections[0],0)',context);
 assert.equal(sec.currentSetStartedAt,undefined);assert.equal(sec.restEndsAt,1000);assert.equal(nodes.get('rest-0').textContent,'Ready');
 vm.runInNewContext('endRest(0,5000)',context);assert.equal(sec.currentSetStartedAt,5000);assert.equal(sec.restEndsAt,null);
});
