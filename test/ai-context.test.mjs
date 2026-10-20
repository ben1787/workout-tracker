import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAIContext, prepareAIContext } from '../ai-context.js';
import { AI_WORKFLOWS, runAIWorkflow } from '../ai/registry.mjs';

const state = () => ({
  goals: [{ id: 'active', title: 'Pull strength', details: '', active: true }, { id: 'inactive', title: 'Old goal', active: false }],
  today: { minutes: 30, equipment: 'Bar, vest', limitations: 'No jumping', feeling: 'Fine' },
  draft: { day: { name: 'Next session', sections: [] }, rationale: 'Recovery', conversation: [{ role: 'user', content: 'Only five exercises' }] },
  active: null,
  workouts: [{ id: 'selected', day: { name: 'Vest workout', type: 'workout' }, startedAt: 1000, endedAt: 1801000, correctedDurationMs: 600000, notes: 'Excluded a phone break', sections: [{ type: 'exercise', exerciseName: 'Pull-ups', weight: 20, completedSets: [{ reps: 5, weight: 20 }] }], resultUndo: { id: 'old-backup' }, progressReview: { summary: 'Previous take' }, correctionConversation: [{ role: 'assistant', content: 'How heavy?' }] }],
});

test('every workflow gets the same actual app evidence without undo or cached-review copies', () => {
  for (const workflow of ['workout', 'progress', 'correction']) {
    const context = buildAIContext({ workflow, state: state(), selectedWorkoutId: 'selected', request: '20 lb', feedback: 'Keep five exercises' });
    assert.deepEqual(context.goals.map(g => g.id), ['active']);
    assert.equal(context.today.limitations, 'No jumping');
    assert.equal(context.currentWorkout.workout.name, 'Next session');
    assert.equal(context.history[0].sections[0].weight, 20);
    assert.equal(context.history[0].sections[0].completedSets[0].weight, 20);
    assert.equal(context.history[0].correctedDurationMs, 600000);
    assert.equal(context.history[0].notes, 'Excluded a phone break');
    assert.equal(context.history[0].resultUndo, undefined);
    assert.equal(context.history[0].progressReview, undefined);
    assert.equal(context.previousReview.summary, 'Previous take');
    assert.equal(context.progress.selected.minutes, 10);
  }
});

test('selected correction follows its own conversation, not the suggestion chat', () => {
  const context = buildAIContext({ workflow: 'correction', state: state(), selectedWorkoutId: 'selected', request: '20 lb' });
  assert.equal(context.workout.id, 'selected');
  assert.equal(context.conversation[0].content, 'How heavy?');
  const revision = buildAIContext({ workflow: 'workout', state: state(), feedback: 'Swap pull-ups' });
  assert.equal(revision.conversation[0].content, 'Only five exercises');
});

test('API boundary also removes inactive goals and undo evidence', () => {
  const s = state(); const context = prepareAIContext({ goals: s.goals, history: s.workouts, workout: s.workouts[0] });
  assert.equal(context.goals.length, 1);
  assert.equal(context.workout.resultUndo, undefined);
  assert.equal(s.workouts[0].resultUndo.id, 'old-backup');
});

test('registry has a bounded workflow per UI action and rejects mismatched contexts', async () => {
  assert.equal(Object.keys(AI_WORKFLOWS).length, 4);
  await assert.rejects(runAIWorkflow('/api/unknown', {}), error => error.status === 404);
  await assert.rejects(runAIWorkflow('/api/progress', { workflow: 'correction' }), error => error.status === 400);
});

test('registry correction uses the shared client and can only change its selected workout', async () => {
  const s = state(); const original = structuredClone(s);
  const context = buildAIContext({ workflow: 'correction', state: s, selectedWorkoutId: 'selected', request: 'It was a 25 lb vest.' });
  const result = await runAIWorkflow('/api/correct-result', context, { apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'gpt-6.1-sol');
    assert.equal(request.store, false);
    const input = JSON.parse(request.input);
    assert.equal(input.workout.id, 'selected');
    assert.equal(input.history[0].correctedDurationMs, 600000);
    const plan = { status: 'apply', message: 'Corrected vest load.', operations: [{ kind: 'vest_weight', value: 25 }] };
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] }));
  } });
  assert.equal(result.workout.id, 'selected');
  assert.equal(result.workout.sections[0].weight, 25);
  assert.equal(result.workout.sections[0].completedSets[0].weight, 25);
  assert.deepEqual(s, original);
});
