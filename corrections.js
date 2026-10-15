// Apply a narrow, validated edit plan to a copy. Never trust AI to replace IDs,
// unrelated sessions or session identity. Explicit workout corrections update both
// its definition and actual logs; the caller retains the previous snapshot for undo.
export function workoutDuration(workout) {
  return Number.isFinite(workout.correctedDurationMs) ? workout.correctedDurationMs : workout.endedAt - workout.startedAt;
}

export function applyCorrections(workout, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('No valid result changes were supplied.');
  const next = structuredClone(workout);
  const number = (value, max = 100000) => {
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error('A corrected value is outside the supported range.');
    return value;
  };
  const index = (items, value) => {
    if (!Array.isArray(items) || !Number.isInteger(value) || value < 0 || value >= items.length) throw new Error('The correction refers to a result that does not exist.');
    return items[value];
  };
  const selected = (items, value) => value === -1 ? (Array.isArray(items) && items.length ? items : (() => { throw new Error('There are no logged results to change.'); })()) : [index(items, value)];
  for (const op of operations) {
    if (op.kind === 'append_note') {
      if (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 4000) throw new Error('The correction note is invalid.');
      next.notes = [next.notes, op.text.trim()].filter(Boolean).join('\n');
    } else if (op.kind === 'session_duration_minutes') {
      next.correctedDurationMs = number(op.value, 1440) * 60000;
    } else if (op.kind === 'exclude_break_minutes') {
      const duration = workoutDuration(next) - number(op.value, 1440) * 60000;
      if (duration < 0) throw new Error('The break is longer than the recorded session.');
      next.correctedDurationMs = duration;
    } else if (op.kind === 'vest_weight') {
      next.vestWeight = number(op.value, 1000);
      if (next.day?.name) next.day.name = next.day.name.replace(/\b(?:no[- ]vest|\d+(?:\.\d+)?\s*lb\s*vest)\b/gi, op.value > 0 ? `${op.value} lb Vest` : 'No-Vest');
      for (const section of next.sections) {
        if (section.type === 'exercise') section.weight = op.value;
        if (section.type === 'circuit') for (const ex of section.exercises || []) ex.weight = op.value;
        for (const set of section.completedSets || []) set.weight = op.value;
        for (const round of section.completedRounds || []) for (const ex of round.exercises || []) ex.weight = op.value;
      }
    } else {
      const section = index(next.sections, op.sectionIndex);
      if (op.kind === 'section_weight') {
        number(op.value, 1000);
        if (section.type === 'exercise') { section.weight = op.value; for (const set of section.completedSets || []) set.weight = op.value; }
        else if (section.type === 'circuit') { for (const ex of section.exercises || []) ex.weight = op.value; for (const round of section.completedRounds || []) for (const ex of round.exercises || []) ex.weight = op.value; }
        else throw new Error('This is not a strength section.');
      } else if (op.kind === 'skip_section') {
        section.skipped = true; section.completed = true;
        if (section.type === 'exercise') section.completedSets = [];
        if (section.type === 'circuit') section.completedRounds = [];
        if (section.timerStartedAt !== undefined) { section.timerStartedAt = null; section.timerEndedAt = null; section.actualMinutes = null; section.actualMiles = null; }
      } else if (op.kind === 'logged_weight' || op.kind === 'logged_reps' || op.kind === 'logged_hold_seconds') {
        number(op.value, op.kind === 'logged_weight' ? 1000 : 100000);
        const key = op.kind === 'logged_weight' ? 'weight' : op.kind === 'logged_hold_seconds' ? 'holdSeconds' : 'reps';
        if (section.type === 'exercise') for (const set of selected(section.completedSets, op.setIndex)) set[key] = op.value;
        else if (section.type === 'circuit') for (const round of selected(section.completedRounds, op.roundIndex)) for (const ex of selected(round.exercises, op.exerciseIndex)) ex[key] = op.value;
        else throw new Error('This section has no logged reps or weights.');
      } else if (op.kind === 'actual_minutes' || op.kind === 'actual_miles') {
        if (!['warmup', 'cooldown', 'cardio', 'mobility'].includes(section.type)) throw new Error('This is not a timed section.');
        section[op.kind === 'actual_minutes' ? 'actualMinutes' : 'actualMiles'] = number(op.value, op.kind === 'actual_minutes' ? 1440 : 1000);
      } else if (op.kind === 'rename_exercise') {
        if (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 300) throw new Error('Enter a valid exercise name.');
        if (section.type === 'exercise') { section.exerciseName = op.text.trim(); delete section.exerciseId; for (const set of section.completedSets || []) delete set.exerciseId; }
        else if (section.type === 'circuit') for (const round of selected(section.completedRounds, op.roundIndex)) { const exercise = index(round.exercises, op.exerciseIndex); exercise.name = op.text.trim(); delete exercise.exerciseId; }
        else throw new Error('There is no logged exercise to rename.');
      } else throw new Error('This result correction is not supported.');
    }
  }
  // Keep labeled result fields consistent with corrected numeric measurements.
  for (const section of next.sections || []) {
    const records = [section, ...(section.completedSets || []), ...(section.completedRounds || []).flatMap(round => round.exercises || [])];
    for (const record of records) for (const [key, field] of Object.entries(record.trackingValues || {})) {
      const property = { minutes: 'actualMinutes', miles: 'actualMiles' }[key] || key;
      if (['reps', 'weight', 'holdSeconds', 'actualMinutes', 'actualMiles'].includes(property) && record[property] != null) field.value = record[property];
    }
  }
  return next;
}
