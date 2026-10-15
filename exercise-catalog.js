const key = name => String(name || '').normalize('NFKC').toLowerCase().replace(/[–—]/g, '-').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const standards = [
  ['Pull-up', ['pull-ups', 'pull ups', 'pullup', 'pullups']],
  ['Push-up', ['push-ups', 'push ups', 'pushup', 'pushups']],
  ['Squat', ['squats', 'bodyweight squats', 'bodyweight squat']],
  ['Strict pull-up', ['strict pull-ups', 'strict pull ups', 'strict weighted pull-ups', 'weighted pull-ups, clean dead-hang reps']],
  ['Wall-facing handstand', ['wall-facing handstand hold']],
  ['Hollow-body hold', ['hollow hold', 'hollow-body hold']],
];

export function canonicalName(name) {
  let clean = String(name || '').trim();
  // Hold prescriptions belong in target fields, not in exercise identity.
  clean = clean.replace(/[,—-]?\s*\d+(?:\s*[-–]\s*\d+)?\s*(?:s|seconds?)\s*(?:hold)?(?=\s*(?:;|$))/i, '').split(';')[0].trim().replace(/[,—-]\s*$/, '');
  for (const [canonical, aliases] of standards) if ([canonical, ...aliases].some(alias => key(alias) === key(clean))) return canonical;
  return clean || String(name || '').trim();
}

export function exerciseIdentity(name) { return `exercise:${encodeURIComponent(key(canonicalName(name)))}`; }
export function findExercise(catalog, id, name) {
  const byId = id && catalog.find(e => e.id === id);
  if (byId) return byId;
  const wanted = key(canonicalName(name));
  return catalog.find(e => key(canonicalName(e.name)) === wanted || (e.aliases || []).some(alias => key(canonicalName(alias)) === wanted));
}
export function createExercise({ name, instructions = '', measurement = 'reps', aliases = [], id } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 300 || !['reps', 'hold', 'distance', 'time'].includes(measurement) || typeof instructions !== 'string' || !Array.isArray(aliases) || aliases.some(a => typeof a !== 'string' || a.length > 300)) throw new Error('Exercise needs a name, a valid measurement, and valid aliases.');
  const canonical = canonicalName(name);
  return { id: id || exerciseIdentity(canonical), name: canonical, instructions, measurement, aliases: [...new Set([name, ...aliases].filter(a => a && a !== canonical))] };
}

function targetHold(name) {
  const match = /(?:^|[,\s—-])(\d+)(?:\s*[-–]\s*\d+)?\s*(?:s|seconds?)\b/i.exec(name || '');
  return match ? Number(match[1]) : 0;
}

// Conservative deterministic migration: keep original text and real results,
// attach shared IDs, merge only exact aliases/known spellings, retain variants.
export function linkExerciseRecords({ exercises = [], workouts = [], plans = [], draft = null, active = null } = {}) {
  const catalog = [];
  const redirects = new Map();
  for (const source of exercises) {
    const exercise = createExercise(source);
    const existing = findExercise(catalog, exercise.id, exercise.name);
    if (existing) { redirects.set(exercise.id, existing.id); existing.aliases = [...new Set([...existing.aliases, exercise.name, ...exercise.aliases])].filter(name => name !== existing.name); }
    else catalog.push(exercise);
  }
  const ensure = (name, id, instructions = '', measurement) => {
    let exercise = findExercise(catalog, redirects.get(id) || id, name);
    if (!exercise) {
      exercise = createExercise({ name, instructions, measurement: measurement || (/\bhold\b/i.test(name) ? 'hold' : 'reps') });
      catalog.push(exercise);
    }
    if (name !== exercise.name && !exercise.aliases.includes(name)) exercise.aliases.push(name);
    return exercise;
  };
  const entry = ex => {
    const exercise = ensure(ex.name, ex.exerciseId || ex.exercise_id, ex.instructions, !ex.reps && (targetHold(ex.name) || /\bhold\b/i.test(ex.name)) ? 'hold' : 'reps');
    return { ...ex, originalName: ex.originalName || ex.name, exerciseId: exercise.id, name: exercise.name, holdSeconds: ex.holdSeconds || ex.hold_seconds || (!ex.reps ? targetHold(ex.name) : 0) };
  };
  const sections = items => (items || []).map(section => {
    const out = { ...section };
    if (section.type === 'exercise') {
      const name = section.exerciseName || section.name;
      const exercise = ensure(name, section.exerciseId, section.exerciseInstructions || section.instructions, !section.reps && (targetHold(name) || /\bhold\b/i.test(name)) ? 'hold' : 'reps');
      out.originalExerciseName = section.originalExerciseName || name;
      out.exerciseId = exercise.id; out.exerciseName = exercise.name;
      out.holdSeconds = section.holdSeconds || (!section.reps ? targetHold(name) : 0);
      out.completedSets = (section.completedSets || []).map(set => ({ ...set, exerciseId: exercise.id }));
    }
    if (section.type === 'circuit') {
      out.exercises = (section.exercises || []).map(entry);
      out.completedRounds = (section.completedRounds || []).map(round => ({ ...round, exercises: (round.exercises || []).map(ex => {
        const linked = entry(ex);
        // Never convert a name's target hold duration to an actual hold result.
        delete linked.holdSeconds;
        if (Number.isFinite(ex.holdSeconds)) linked.holdSeconds = ex.holdSeconds;
        return linked;
      }) }));
    }
    if (section.type === 'cardio') {
      const exercise = ensure(section.name, section.exerciseId, section.instructions, 'distance');
      out.exerciseId = exercise.id;
    }
    return out;
  });
  const record = workout => {
    const linked = { ...workout, sections: sections(workout.sections) };
    if (workout.resultUndo) linked.resultUndo = { ...workout.resultUndo, sections: sections(workout.resultUndo.sections) };
    return linked;
  };
  const linkedPlans = plans.map(plan => ({ ...plan, days: plan.days.map(day => ({ ...day, sections: sections(day.sections) })) }));
  const linkedDraft = draft ? { ...draft, day: { ...draft.day, sections: sections(draft.day.sections) } } : null;
  const linkedActive = active ? record(active) : null;
  return { exercises: catalog, workouts: workouts.map(record), plans: linkedPlans, draft: linkedDraft, active: linkedActive };
}

// Validate AI references before the UI can use a suggestion. Unknown exercises
// must have an explicit new definition; there is no silent free-text fallback.
export function resolveGeneratedExercises(data, existing = []) {
  const catalog = existing.map(e => createExercise(e));
  const updates = [];
  for (const definition of data.newExercises || []) {
    if (!definition.instructions || definition.instructions.trim().length < 40) throw new Error('New exercises need technique instructions.');
    const exercise = createExercise(definition);
    if (!findExercise(catalog, null, exercise.name)) { catalog.push(exercise); updates.push(exercise); }
  }
  const resolve = (id, name) => {
    const exercise = findExercise(catalog, id, name);
    if (!exercise) throw new Error('AI used an exercise that is not in the catalog or new definitions.');
    if (id && !catalog.some(e => e.id === id)) throw new Error('AI returned an unknown exercise ID.');
    return exercise;
  };
  const result = structuredClone(data);
  const used = new Set();
  for (const section of result.workout.sections) {
    for (const ex of section.exercises || []) {
      const exercise = resolve(ex.exercise_id, ex.name);
      ex.exercise_id = exercise.id; ex.name = exercise.name; used.add(exercise.id);
    }
    if (section.type === 'cardio') {
      const exercise = resolve(section.exercise_id, section.section_name);
      section.exercise_id = exercise.id; section.section_name = exercise.name; used.add(exercise.id);
    }
  }
  result.catalogUpdates = updates.filter(e => used.has(e.id));
  return result;
}
