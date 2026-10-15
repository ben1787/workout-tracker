import { workoutDuration } from './corrections.js';
// Derive charts only from recorded results, never prescribed targets.
export function recordedExercises(workout) {
  const exercises = new Map();
  const add = (name, reps, weight, exerciseId, holdSeconds, extra = {}) => {
    if (typeof name !== 'string') return;
    const key = exerciseId || name.trim().toLowerCase().replace(/\s+/g, ' ');
    const entry = exercises.get(key) || { key, exerciseId: exerciseId || null, name: name.trim(), reps: 0, weight: 0, bestSetReps: 0, holdSeconds: null, sets: 0, miles: 0, minutes: 0, performances: [] };
    const actualReps = Number.isFinite(reps) && reps > 0 ? reps : 0;
    entry.measuredReps ||= Number.isFinite(reps);
    entry.measuredWeight ||= Number.isFinite(weight);
    entry.reps += actualReps;
    entry.bestSetReps = Math.max(entry.bestSetReps, actualReps);
    entry.weight = Math.max(entry.weight, Number.isFinite(weight) && weight > 0 ? weight : 0);
    if (Number.isFinite(holdSeconds) && holdSeconds >= 0) entry.holdSeconds = Math.max(entry.holdSeconds || 0, holdSeconds);
    entry.sets++;
    entry.performances.push({ reps: Number.isFinite(reps) ? reps : null, weight: Number.isFinite(weight) ? weight : null, trackingValues: extra.trackingValues || {}, holdSeconds: Number.isFinite(holdSeconds) ? holdSeconds : null, block: extra.block || null, format: extra.format || 'sets' });
    entry.miles += extra.miles || 0; entry.minutes += extra.minutes || 0;
    exercises.set(key, entry);
  };
  for (const [sectionIndex, section] of (workout.sections || []).entries()) {
    const context = { block: sectionIndex + 1, format: section.type === 'circuit' ? 'circuit' : section.type === 'exercise' ? 'sets' : 'timed' };
    if (section.type === 'circuit') for (const round of section.completedRounds || []) for (const ex of (round.exercises || []).filter(e => !e.skipped)) add(ex.name, ex.reps, ex.weight, ex.exerciseId, ex.holdSeconds, { ...context, trackingValues: ex.trackingValues });
    if (section.type === 'exercise') for (const set of section.completedSets || []) add(section.exerciseName || section.name, set.reps, set.weight, set.exerciseId || section.exerciseId, set.holdSeconds, { ...context, trackingValues: set.trackingValues });
    if (section.type === 'cardio' && !section.skipped && (section.completed || section.timerEndedAt != null)) {
      const elapsed = section.timerEndedAt - section.timerStartedAt;
      const minutes = section.actualMinutes > 0 ? section.actualMinutes : elapsed > 0 && elapsed <= 6 * 3600000 ? elapsed / 60000 : 0;
      add(section.name, 0, 0, section.exerciseId, null, { ...context, miles: section.actualMiles > 0 ? section.actualMiles : 0, minutes });
    }
  }
  return [...exercises.values()].map(entry => ({ ...entry, reps: entry.measuredReps ? entry.reps : null, bestSetReps: entry.measuredReps ? entry.bestSetReps : null, weight: entry.measuredWeight ? entry.weight : null }));
}

export function workoutMetrics(workout) {
  const reps = recordedExercises(workout).reduce((sum, ex) => sum + ex.reps, 0);
  const elapsed = workoutDuration(workout);
  const durationValid = Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 6 * 3600000;
  const trained = workout.day?.type !== 'rest' && (workout.sections || []).some(s =>
    (s.completedRounds || []).length || (s.completedSets || []).length || (s.timerStartedAt != null && s.timerEndedAt > s.timerStartedAt) || s.actualMinutes > 0 || s.actualMiles > 0);
  return { reps, trained, minutes: trained && durationValid ? elapsed / 60000 : 0, unusualDuration: trained && !durationValid };
}

function startOfWeek(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d;
}

export function weeklyProgress(workouts, today = new Date(), count = 8) {
  const latest = startOfWeek(today);
  const weeks = Array.from({ length: count }, (_, i) => {
    const date = new Date(latest); date.setDate(date.getDate() - (count - 1 - i) * 7);
    return { when: date.getTime(), sessions: 0, reps: 0, minutes: 0, unusualDurations: 0 };
  });
  for (const w of workouts) {
    if (!Number.isFinite(w.startedAt) || !Number.isFinite(w.endedAt) || w.startedAt > +today) continue;
    const week = weeks.find(item => item.when === +startOfWeek(w.startedAt));
    if (!week) continue;
    const metrics = workoutMetrics(w);
    if (metrics.trained) week.sessions++;
    week.reps += metrics.reps;
    week.minutes += metrics.minutes;
    if (metrics.unusualDuration) week.unusualDurations++;
  }
  return weeks;
}

export function exerciseProgress(workouts, catalog = []) {
  const byExercise = new Map();
  for (const w of [...workouts].sort((a, b) => a.startedAt - b.startedAt)) {
    if (!Number.isFinite(w.startedAt) || !Number.isFinite(w.endedAt)) continue;
    for (const ex of recordedExercises(w)) {
      const definition = catalog.find(e => e.id === ex.exerciseId);
      const entry = byExercise.get(ex.key) || { key: ex.key, exerciseId: ex.exerciseId, name: definition?.name || ex.name, measurement: definition?.measurement || 'reps', entries: [] };
      entry.entries.push({ workoutId: w.id, workoutName: w.day?.name || 'Workout', when: w.startedAt, reps: ex.reps, weight: ex.weight, bestSetReps: ex.bestSetReps, holdSeconds: ex.holdSeconds, sets: ex.sets, miles: ex.miles, minutes: ex.minutes, performances: ex.performances, positions: [...new Set(ex.performances.map(p => p.block))], formats: [...new Set(ex.performances.map(p => p.format))] });
      byExercise.set(ex.key, entry);
    }
  }
  return [...byExercise.values()].sort((a, b) => b.entries.at(-1).when - a.entries.at(-1).when || a.name.localeCompare(b.name));
}

// Performance comparisons use results at the selected load, not a session's
// heaviest weight paired with reps that were done at a different weight.
export function exerciseAtLoad(entry, load) {
  if (load === 'all') return entry;
  const performances = entry.performances.filter(p => p.weight === Number(load));
  if (!performances.length) return null;
  const holds = performances.filter(p => p.holdSeconds != null).map(p => p.holdSeconds);
  return { ...entry, performances, reps: performances.reduce((sum, p) => sum + p.reps, 0), bestSetReps: performances.some(p => p.reps != null) ? Math.max(...performances.map(p => p.reps || 0)) : null, weight: Number(load), holdSeconds: holds.length ? Math.max(...holds) : null, sets: performances.length, positions: [...new Set(performances.map(p => p.block))], formats: [...new Set(performances.map(p => p.format))] };
}
