import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrections, workoutDuration } from '../corrections.js';
import { workoutMetrics } from '../progress.js';

const workout = () => ({ id: 'saved', planId: 'legacy', day: { name: 'Controlled No-Vest Session', type: 'workout' }, startedAt: 1000, endedAt: 3601000, sections: [{ type: 'exercise', exerciseName: 'Pull-ups', weight: 0, completedSets: [{ reps: 5, weight: 0 }] }, { type: 'circuit', exercises: [{ name: 'Push-ups', reps: 10, weight: 0 }], completedRounds: [{ startedAt: 1000, endedAt: 61000, exercises: [{ name: 'Push-ups', reps: 10, weight: 0 }] }] }] });

test('vest corrections update the workout definition, title and actual logs together', () => {
  const original = workout(); const updated = applyCorrections(original, [{ kind: 'vest_weight', value: 20 }]);
  assert.equal(updated.day.name, 'Controlled 20 lb Vest Session');
  assert.equal(updated.sections[0].weight, 20);
  assert.equal(updated.sections[0].completedSets[0].weight, 20);
  assert.equal(updated.sections[1].exercises[0].weight, 20);
  assert.equal(updated.sections[1].completedRounds[0].exercises[0].weight, 20);
  assert.equal(original.sections[0].weight, 0);
  assert.equal(updated.id, original.id);
  assert.equal(updated.planId, original.planId);
});

test('a section correction changes that workout component but leaves other components alone', () => {
  const updated = applyCorrections(workout(), [{ kind: 'section_weight', sectionIndex: 0, value: 15 }]);
  assert.equal(updated.sections[0].weight, 15);
  assert.equal(updated.sections[0].completedSets[0].weight, 15);
  assert.equal(updated.sections[1].exercises[0].weight, 0);
});

test('a specific result edit changes its log without rewriting unrelated target loads', () => {
  const updated = applyCorrections(workout(), [{ kind: 'logged_weight', sectionIndex: 0, setIndex: 0, value: 10 }]);
  assert.equal(updated.sections[0].completedSets[0].weight, 10);
  assert.equal(updated.sections[0].weight, 0);
});

test('explaining a break adds context without inventing a different time', () => {
  const original = workout(); const updated = applyCorrections(original, [{ kind: 'append_note', text: 'I took a phone call.' }]);
  assert.equal(workoutDuration(updated), workoutDuration(original));
  assert.match(updated.notes, /phone call/);
});

test('explicit break exclusion changes charts but preserves original timer and splits', () => {
  const original = workout(); const updated = applyCorrections(original, [{ kind: 'exclude_break_minutes', value: 20 }]);
  assert.equal(workoutDuration(updated), 40 * 60000);
  assert.equal(workoutMetrics(updated).minutes, 40);
  assert.equal(updated.endedAt, original.endedAt);
  assert.deepEqual(updated.sections, original.sections);
});

test('marking an unperformed section clears its actual logs', () => {
  const updated = applyCorrections(workout(), [{ kind: 'skip_section', sectionIndex: 0 }]);
  assert.equal(updated.sections[0].skipped, true);
  assert.equal(updated.sections[0].completedSets.length, 0);
  assert.equal(workoutMetrics(updated).reps, 10);
});

test('invalid operations fail atomically without mutating the source', () => {
  const original = workout(); const before = structuredClone(original);
  assert.throws(() => applyCorrections(original, [{ kind: 'vest_weight', value: 20 }, { kind: 'logged_reps', sectionIndex: 99, value: 5 }]), /does not exist/);
  assert.deepEqual(original, before);
  assert.throws(() => applyCorrections(original, [{ kind: 'exclude_break_minutes', value: 120 }]), /longer/);
});
