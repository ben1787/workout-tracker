import test from 'node:test';
import assert from 'node:assert/strict';
import { chronologicalContext } from '../ai-time.js';
import { prepareAIContext } from '../ai-context.js';

const workout = (id, start, end, type = 'workout') => ({ id, startedAt: Date.parse(start), endedAt: Date.parse(end), day: { type }, sections: type === 'rest' ? [] : [{ type: 'exercise', completedSets: [{ reps: 5, weight: 0 }] }] });

test('history is oldest first with explicit local dates, elapsed gaps and today', () => {
  const later = workout('later', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z');
  const earlier = workout('earlier', '2026-10-10T08:00:00Z', '2026-10-10T09:00:00Z');
  const original = [later, earlier];
  const result = chronologicalContext(original, { now: new Date('2026-10-15T10:00:00Z'), timeZone: 'Asia/Jerusalem', selectedWorkoutId: 'earlier' });
  assert.deepEqual(result.history.map(w => w.id), ['earlier', 'later']);
  assert.equal(result.date, '2026-10-15');
  assert.equal(result.history[1].timing.hoursSincePreviousCompletion, 95);
  assert.equal(result.history[1].timing.localDate, '2026-10-14');
  assert.equal(result.timeContext.hoursSinceLatestTraining, 25);
  assert.equal(result.timeContext.calendarDaysSinceLatestTraining, 1);
  assert.equal(result.timeContext.selectedWorkoutCalendarDaysAgo, 5);
  assert.equal(original[0].id, 'later');
  assert.equal(later.timing, undefined);
});

test('today follows the user timezone across UTC midnight', () => {
  const result = chronologicalContext([], { now: new Date('2026-10-14T22:30:00Z'), timeZone: 'Asia/Jerusalem' });
  assert.equal(result.date, '2026-10-15');
  assert.equal(result.timeContext.nowUtc, '2026-10-14T22:30:00.000Z');
});

test('calendar days and exact elapsed hours remain distinct over daylight saving changes', () => {
  const w = workout('dst', '2026-10-24T20:00:00Z', '2026-10-24T21:00:00Z');
  const result = chronologicalContext([w], { now: new Date('2026-10-25T22:00:00Z'), timeZone: 'Asia/Jerusalem' });
  assert.equal(result.timeContext.hoursSinceLatestTraining, 25);
  assert.equal(result.timeContext.calendarDaysSinceLatestTraining, 1);
});

test('rest days, future dates and unknown timestamps do not invent recent training', () => {
  const training = workout('training', '2026-10-10T08:00:00Z', '2026-10-10T09:00:00Z');
  const rest = workout('rest', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z', 'rest');
  const future = workout('future', '2026-10-16T08:00:00Z', '2026-10-16T09:00:00Z');
  const result = chronologicalContext([future, rest, training, { id: 'unknown', day: {}, sections: [] }], { now: new Date('2026-10-15T10:00:00Z'), timeZone: 'Asia/Jerusalem' });
  assert.equal(result.timeContext.latestCompletedWorkoutId, 'rest');
  assert.equal(result.timeContext.latestTrainingWorkoutId, 'training');
  assert.deepEqual(result.timeContext.futureDatedWorkoutIds, ['future']);
  assert.deepEqual(result.timeContext.unknownTimestampWorkoutIds, ['unknown']);
  assert.equal(result.history.at(-1).timing.hoursSinceCompletion, null);
});

test('overlapping timers are explicit and do not become negative recovery', () => {
  const first = workout('first', '2026-10-10T08:00:00Z', '2026-10-11T08:00:00Z');
  const second = workout('second', '2026-10-10T10:00:00Z', '2026-10-10T11:00:00Z');
  const result = chronologicalContext([first, second], { now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(result.history[1].timing.overlapsPreviousWorkout, true);
  assert.equal(result.history[1].timing.hoursSincePreviousCompletion, null);
});

test('server refreshes stale client date and corrected work duration never moves workout dates', () => {
  const w = { ...workout('selected', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z'), correctedDurationMs: 60000 };
  const result = prepareAIContext({ date: '1999-01-01', timeZone: 'Asia/Jerusalem', history: [w] }, { now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(result.date, '2026-10-15');
  assert.equal(result.timeContext.hoursSinceLatestTraining, 25);
  assert.equal(result.history[0].startedAt, w.startedAt);
  assert.equal(result.history[0].endedAt, w.endedAt);
  assert.equal(result.history[0].correctedDurationMs, 60000);
});
