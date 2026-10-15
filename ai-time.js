import { workoutMetrics } from './progress.js';

const HOUR = 3600000;
function validTime(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000; }
function zoneOrUTC(zone) {
  try { if (!zone) return 'UTC'; new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return zone; }
  catch { return 'UTC'; }
}
function localDate(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function localTime(timestamp, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(timestamp);
}
function calendarDays(from, to, timeZone) {
  return (Date.parse(localDate(to, timeZone)) - Date.parse(localDate(from, timeZone))) / 86400000;
}
const hours = milliseconds => Number((milliseconds / HOUR).toFixed(3));

// Build time facts, rather than asking a model to infer epochs, array order,
// recovery intervals, calendar days, or daylight-saving transitions itself.
export function chronologicalContext(workouts, { now = new Date(), timeZone, selectedWorkoutId } = {}) {
  const timestamp = +now;
  if (!validTime(timestamp)) throw new Error('Invalid current time.');
  const zone = zoneOrUTC(timeZone);
  const history = [...workouts].sort((a, b) => {
    const startA = validTime(a?.startedAt) ? a.startedAt : Infinity;
    const startB = validTime(b?.startedAt) ? b.startedAt : Infinity;
    return startA - startB || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  let previous = null;
  const dated = history.map(workout => {
    if (!workout) return workout;
    const startValid = validTime(workout.startedAt), endValid = validTime(workout.endedAt);
    const overlaps = startValid && validTime(previous?.endedAt) && workout.startedAt < previous.endedAt;
    const timing = {
      startedAtUtc: startValid ? new Date(workout.startedAt).toISOString() : null,
      endedAtUtc: endValid ? new Date(workout.endedAt).toISOString() : null,
      startedAtLocal: startValid ? localTime(workout.startedAt, zone) : null,
      endedAtLocal: endValid ? localTime(workout.endedAt, zone) : null,
      localDate: startValid ? localDate(workout.startedAt, zone) : null,
      calendarDaysAgo: startValid ? calendarDays(workout.startedAt, timestamp, zone) : null,
      hoursSinceCompletion: endValid && workout.endedAt <= timestamp ? hours(timestamp - workout.endedAt) : null,
      previousWorkoutId: previous?.id || null,
      hoursSincePreviousCompletion: startValid && validTime(previous?.endedAt) && !overlaps ? hours(workout.startedAt - previous.endedAt) : null,
      calendarDaysSincePreviousWorkout: startValid && validTime(previous?.startedAt) ? calendarDays(previous.startedAt, workout.startedAt, zone) : null,
      overlapsPreviousWorkout: overlaps,
      futureDated: (startValid && workout.startedAt > timestamp) || (endValid && workout.endedAt > timestamp),
    };
    if (startValid) previous = workout;
    return { ...workout, timing };
  });
  const completed = dated.filter(w => validTime(w?.startedAt) && validTime(w?.endedAt) && w.endedAt >= w.startedAt && w.endedAt <= timestamp).sort((a, b) => a.endedAt - b.endedAt);
  const latest = completed.at(-1);
  const latestTraining = completed.filter(w => workoutMetrics(w).trained).at(-1);
  const selected = dated.find(w => w?.id === selectedWorkoutId);
  return {
    history: dated,
    date: localDate(timestamp, zone), timeZone: zone,
    timeContext: {
      nowUtc: new Date(timestamp).toISOString(), nowLocal: localTime(timestamp, zone),
      date: localDate(timestamp, zone), timeZone: zone,
      historyOrder: 'oldest_first_by_startedAt',
      latestCompletedWorkoutId: latest?.id || null,
      hoursSinceLatestCompletion: latest ? hours(timestamp - latest.endedAt) : null,
      latestTrainingWorkoutId: latestTraining?.id || null,
      hoursSinceLatestTraining: latestTraining ? hours(timestamp - latestTraining.endedAt) : null,
      calendarDaysSinceLatestTraining: latestTraining ? calendarDays(latestTraining.endedAt, timestamp, zone) : null,
      selectedWorkoutId: selected?.id || null,
      selectedWorkoutHoursAgo: selected?.timing.hoursSinceCompletion ?? null,
      selectedWorkoutCalendarDaysAgo: selected?.timing.calendarDaysAgo ?? null,
      unknownTimestampWorkoutIds: dated.filter(w => !validTime(w?.startedAt) || !validTime(w?.endedAt)).map(w => w?.id || null),
      futureDatedWorkoutIds: dated.filter(w => w?.timing.futureDated).map(w => w.id),
    },
  };
}
