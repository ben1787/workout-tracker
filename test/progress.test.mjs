import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedExercises, workoutMetrics, weeklyProgress, exerciseProgress } from '../progress.js';
import { progressRequest, reviewProgress } from '../ai.mjs';

const at = new Date(2026, 9, 15, 12).getTime();
const session = (overrides = {}) => ({ id: 'completed', day: { name: 'Pull session', type: 'workout' }, startedAt: at - 1800000, endedAt: at, sections: [{ type: 'exercise', name: 'Pull-ups', exerciseName: 'Pull-ups', sets: 10, reps: 99, completedSets: [{ reps: 3, weight: 10 }, { reps: 4, weight: 20 }] }], ...overrides });

test('chart values use logged results rather than targets, including work before a skip', () => {
  const w = session();
  w.sections[0].skipped = true;
  assert.deepEqual(recordedExercises(w).map(({key, name, reps, weight}) => ({key, name, reps, weight})), [{ key: 'pull-ups', name: 'Pull-ups', reps: 7, weight: 20 }]);
  assert.equal(workoutMetrics(w).reps, 7);
  assert.equal(workoutMetrics(w).trained, true);
});

test('circuit logs aggregate actual per-exercise reps and heaviest load', () => {
  const w = session({ sections: [{ type: 'circuit', rounds: 20, completedRounds: [{ exercises: [{ name: 'Pull-ups', reps: 5, weight: 10 }] }, { exercises: [{ name: 'Pull-ups', reps: 4, weight: 0 }] }] }] });
  assert.equal(recordedExercises(w)[0].reps, 9);
  assert.equal(recordedExercises(w)[0].weight, 10);
});

test('forgotten timers do not inflate time charts or erase recorded reps', () => {
  const w = session({ startedAt: at - 48 * 3600000 });
  const metrics = workoutMetrics(w);
  assert.equal(metrics.minutes, 0);
  assert.equal(metrics.unusualDuration, true);
  assert.equal(metrics.reps, 7);
});

test('weekly charts use calendar weeks and exclude rest/unperformed work and future sessions', () => {
  const rest = session({ id: 'rest', day: { type: 'rest' }, sections: [] });
  const unperformed = session({ id: 'skipped', sections: [{ type: 'exercise', skipped: true, sets: 3, reps: 10, completedSets: [] }] });
  const future = session({ id: 'future', startedAt: at + 86400000, endedAt: at + 86500000 });
  const weeks = weeklyProgress([session(), rest, unperformed, future], new Date(at));
  assert.equal(weeks.length, 8);
  assert.equal(weeks.at(-1).sessions, 1);
  assert.equal(weeks.at(-1).reps, 7);
  assert.equal(weeks.at(-1).minutes, 30);
  assert.equal(weeks.reduce((sum, w) => sum + w.sessions, 0), 1);
});

test('exercise history keeps variants separate and retains unmeasured holds without inventing seconds', () => {
  const w = session();
  w.sections.push({ type: 'exercise', exerciseName: 'Strict pull-ups', completedSets: [{ reps: 2, weight: 0 }] });
  w.sections.push({ type: 'exercise', exerciseName: 'Front lever 10s hold', completedSets: [{ reps: 0, weight: 0, startedAt: at - 20000, endedAt: at }] });
  const exercises = exerciseProgress([w]);
  assert.equal(exercises.length, 3);
  assert.equal(exercises.find(e => e.name === 'Front lever 10s hold').entries[0].holdSeconds, null);
  assert.ok(exercises.some(e => e.name === 'Strict pull-ups'));
  assert.ok(exercises.some(e => e.name === 'Pull-ups'));
});

test('progress reviews receive the completed session once and every historical session', async () => {
  const completed = session();
  const history = Array.from({ length: 55 }, (_, i) => session({ id: `prior-${i}` }));
  history.push(completed);
  const context = { completedWorkoutId: completed.id, goals: [], history };
  const review = { summary: 'Seven logged pull-ups.', observations: ['Recorded 10–20 lb of load.'], nextStep: 'Compare the same variation next time.' };
  const result = await reviewProgress(context, { apiKey: 'test-only', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'gpt-6.1-sol');
    assert.equal(request.store, false);
    const input = JSON.parse(request.input);
    assert.equal(input.history.length, 56);
    assert.equal(input.history.filter(w => w.id === 'completed').length, 1);
    assert.equal(input.goals.length, 0);
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(review) }] }] }));
  } });
  assert.equal(result.summary, review.summary);
  assert.equal(result.model, 'gpt-6.1-sol');
});

test('progress validates completion and handles failure without manufacturing commentary', async () => {
  assert.throws(() => progressRequest({ history: [], goals: [], completedWorkoutId: 'missing' }, 'gpt-6.1-sol'), /completed workout/);
  const context = { history: [session()], goals: [], completedWorkoutId: 'completed' };
  await assert.rejects(reviewProgress(context), /not connected/);
  await assert.rejects(reviewProgress(context, { apiKey: 'test-only', fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete' })) }), /could not complete/);
  await assert.rejects(reviewProgress(context, { apiKey: 'test-only', fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [] })) }), /incomplete/);
});
