import * as db from './db.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const ACTIVE_KEY = 'wt.active';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
const now = () => Date.now();

const state = {
  view: 'home',
  routines: [],
  workouts: [],
  active: null,
  selectedWorkoutId: null,
  pasteText: '',
  pasteError: '',
};

let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.active) acquireWakeLock();
});

function saveActive() {
  if (state.active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(state.active));
  else localStorage.removeItem(ACTIVE_KEY);
}
function loadActive() {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function fmtDuration(ms) {
  if (ms == null) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'html') e.innerHTML = v;
    else if (v === false || v == null) continue;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 1800);
}

function parseRoutine(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Expected a JSON object.');
  if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('Missing "name" (string).');
  if (!Array.isArray(data.exercises) || data.exercises.length === 0) throw new Error('Missing "exercises" array.');
  const exercises = data.exercises.map((ex, i) => {
    if (!ex || typeof ex !== 'object') throw new Error(`Exercise ${i + 1}: not an object.`);
    if (typeof ex.name !== 'string' || !ex.name.trim()) throw new Error(`Exercise ${i + 1}: missing "name".`);
    const sets = Number(ex.sets);
    if (!Number.isFinite(sets) || sets <= 0) throw new Error(`Exercise ${i + 1} (${ex.name}): "sets" must be > 0.`);
    const reps = Number(ex.reps);
    if (!Number.isFinite(reps) || reps < 0) throw new Error(`Exercise ${i + 1} (${ex.name}): "reps" must be a number.`);
    const weight = ex.weight == null ? 0 : Number(ex.weight);
    if (!Number.isFinite(weight)) throw new Error(`Exercise ${i + 1} (${ex.name}): "weight" must be a number.`);
    return { name: ex.name.trim(), sets, reps, weight };
  });
  return {
    id: uid(),
    name: data.name.trim(),
    createdAt: now(),
    exercises,
  };
}

function buildActive(routine) {
  return {
    id: uid(),
    routineId: routine.id,
    routineName: routine.name,
    startedAt: now(),
    endedAt: null,
    currentExIdx: 0,
    currentSetIdx: 0,
    exercises: routine.exercises.map(ex => ({
      name: ex.name,
      targetSets: ex.sets,
      targetReps: ex.reps,
      targetWeight: ex.weight,
      sets: Array.from({ length: ex.sets }, () => ({
        reps: null, weight: null, startedAt: null, endedAt: null,
      })),
    })),
  };
}

function go(view, extra = {}) {
  state.view = view;
  Object.assign(state, extra);
  render();
}

function render() {
  const app = document.getElementById('app');
  app.replaceChildren();
  const view = views[state.view] || views.home;
  view(app);
}

const views = {
  home(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('div', { class: 'title' }, [el('h1', {}, 'Workouts')]),
      el('button', { class: 'icon ghost', on: { click: () => go('history') } }, 'History'),
    ]));

    root.appendChild(el('button', { class: 'primary', on: { click: () => go('paste') } }, '+ Paste workout JSON'));

    if (state.routines.length === 0) {
      root.appendChild(el('div', { class: 'empty' }, 'No saved workouts yet. Paste a routine to begin.'));
    } else {
      const list = el('div', { class: 'list' });
      for (const r of state.routines) {
        const totalSets = r.exercises.reduce((s, e) => s + e.sets, 0);
        list.appendChild(el('div', { class: 'card tap', on: { click: () => startWorkout(r) } }, [
          el('div', { class: 'spread' }, [
            el('div', { class: 'exercise-name' }, r.name),
            el('button', { class: 'danger', on: { click: (e) => { e.stopPropagation(); removeRoutine(r); } } }, 'Delete'),
          ]),
          el('div', { class: 'muted' }, `${r.exercises.length} exercises · ${totalSets} sets`),
        ]));
      }
      root.appendChild(list);
    }
  },

  paste(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('home') } }, '← Back'),
      el('div', { class: 'title' }, [el('h1', {}, 'Paste workout')]),
    ]));

    const example = JSON.stringify({
      name: 'Push Day',
      exercises: [
        { name: 'Push-ups', sets: 3, reps: 12, weight: 0 },
        { name: 'Dips', sets: 3, reps: 8, weight: 20 },
        { name: 'Pike push-ups', sets: 3, reps: 8, weight: 0 },
      ],
    }, null, 2);

    root.appendChild(el('p', { class: 'muted' }, 'Have ChatGPT build a routine for you — copy the prompt below, paste it into ChatGPT, then paste its JSON output here.'));

    root.appendChild(el('button', { class: 'ghost', on: { click: () => copyChatGPTPrompt() } }, '📋 Copy ChatGPT prompt'));

    root.appendChild(el('p', { class: 'muted' }, 'Or paste workout JSON directly. Format: name + exercises. weight is vest weight (lbs).'));

    const ta = el('textarea', {
      placeholder: example,
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    });
    ta.value = state.pasteText;
    ta.addEventListener('input', () => { state.pasteText = ta.value; });
    root.appendChild(ta);

    if (state.pasteError) root.appendChild(el('div', { class: 'error' }, state.pasteError));

    root.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'ghost', on: { click: () => { state.pasteText = example; state.pasteError = ''; render(); } } }, 'Insert example'),
      el('button', { class: 'primary', on: { click: () => savePaste() } }, 'Save'),
    ]));
  },

  workout(root) {
    const a = state.active;
    if (!a) { go('home'); return; }

    root.appendChild(el('div', { class: 'header' }, [
      el('div', { class: 'title' }, [
        el('h1', {}, a.routineName),
        el('div', { class: 'muted' }, [el('span', { class: 'timer', id: 'wktimer' }, '0:00')]),
      ]),
      el('button', { class: 'danger', on: { click: () => cancelWorkout() } }, 'Cancel'),
    ]));

    a.exercises.forEach((e, i) => {
      const completed = e.sets.every(s => s.endedAt);
      const isCurrent = i === a.currentExIdx;
      const card = el('div', { class: 'card' + (isCurrent ? ' current' : '') });
      card.appendChild(el('div', { class: 'spread' }, [
        el('div', { class: 'exercise-name' }, e.name),
        el('div', { class: 'target' }, `${e.targetSets} × ${e.targetReps}${e.targetWeight ? ` @ ${e.targetWeight}lb` : ''}`),
      ]));

      if (isCurrent || completed) {
        const setsWrap = el('div', { class: 'col' });
        e.sets.forEach((s, si) => setsWrap.appendChild(renderSet(e, s, i, si)));
        card.appendChild(setsWrap);

        if (isCurrent && completed) {
          card.appendChild(el('button', { class: 'primary', on: { click: () => advanceExercise() } },
            i === a.exercises.length - 1 ? 'Finish workout' : 'Next exercise →'));
        }
      } else {
        card.appendChild(el('div', { class: 'muted' }, `Up next`));
      }

      root.appendChild(card);
    });

    startTimerTick();
  },

  history(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('home') } }, '← Back'),
      el('div', { class: 'title' }, [el('h1', {}, 'History')]),
      el('button', { class: 'icon ghost', on: { click: () => exportData() } }, 'Export'),
    ]));

    if (state.workouts.length === 0) {
      root.appendChild(el('div', { class: 'empty' }, 'No completed workouts yet.'));
      return;
    }

    const list = el('div', { class: 'list' });
    for (const w of state.workouts) {
      const dur = w.endedAt ? w.endedAt - w.startedAt : null;
      const totalReps = w.exercises.reduce((sum, e) =>
        sum + e.sets.reduce((s, set) => s + (set.reps || 0), 0), 0);
      list.appendChild(el('div', { class: 'card tap', on: { click: () => go('workoutDetail', { selectedWorkoutId: w.id }) } }, [
        el('div', { class: 'spread' }, [
          el('div', { class: 'exercise-name' }, w.routineName),
          el('div', { class: 'pill' }, fmtDuration(dur)),
        ]),
        el('div', { class: 'muted' }, `${fmtDate(w.startedAt)} · ${totalReps} total reps`),
      ]));
    }
    root.appendChild(list);
  },

  workoutDetail(root) {
    const w = state.workouts.find(x => x.id === state.selectedWorkoutId);
    if (!w) { go('history'); return; }
    const dur = w.endedAt ? w.endedAt - w.startedAt : null;

    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('history') } }, '← Back'),
      el('div', { class: 'title' }, [
        el('h1', {}, w.routineName),
        el('div', { class: 'muted' }, `${fmtDate(w.startedAt)} · ${fmtDuration(dur)}`),
      ]),
      el('button', { class: 'danger', on: { click: () => deleteHistoryEntry(w) } }, 'Delete'),
    ]));

    for (const e of w.exercises) {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'spread' }, [
        el('div', { class: 'exercise-name' }, e.name),
        el('div', { class: 'target' }, `target ${e.targetSets} × ${e.targetReps}${e.targetWeight ? ` @ ${e.targetWeight}lb` : ''}`),
      ]));
      const list = el('div', { class: 'col' });
      e.sets.forEach((s, si) => {
        list.appendChild(el('div', { class: 'set-row done' }, [
          el('div', { class: 'label' }, `${si + 1}`),
          el('div', { class: 'mono' }, `${s.reps ?? '–'} reps`),
          el('div', { class: 'mono' }, `${s.weight ?? 0} lb`),
          el('div', { class: 'pill' }, s.endedAt && s.startedAt ? fmtDuration(s.endedAt - s.startedAt) : '–'),
        ]));
      });
      card.appendChild(list);
      root.appendChild(card);
    }
  },
};

function renderSet(ex, set, exIdx, setIdx) {
  const a = state.active;
  const isCurrentEx = exIdx === a.currentExIdx;
  const isActive = isCurrentEx && setIdx === a.currentSetIdx && set.startedAt && !set.endedAt;
  const isDone = !!set.endedAt;
  const isPending = !set.startedAt && !set.endedAt;
  const isNext = isCurrentEx && setIdx === a.currentSetIdx && isPending;

  const cls = 'set-row' + (isDone ? ' done' : '') + (isActive ? ' active' : '');
  const row = el('div', { class: cls });
  row.appendChild(el('div', { class: 'label' }, `${setIdx + 1}`));

  if (isDone) {
    row.appendChild(el('div', { class: 'mono' }, `${set.reps} reps`));
    row.appendChild(el('div', { class: 'mono' }, `${set.weight} lb`));
    row.appendChild(el('div', { class: 'pill' }, fmtDuration(set.endedAt - set.startedAt)));
  } else if (isActive) {
    const repsIn = el('input', { type: 'number', inputmode: 'numeric', value: ex.targetReps, min: '0' });
    const wtIn = el('input', { type: 'number', inputmode: 'decimal', value: ex.targetWeight, min: '0', step: '0.5' });
    row.appendChild(repsIn);
    row.appendChild(wtIn);
    row.appendChild(el('button', { class: 'primary', on: { click: () => completeSet(exIdx, setIdx, repsIn.value, wtIn.value) } }, 'Done'));
  } else if (isNext) {
    row.appendChild(el('div', { class: 'mono muted' }, `${ex.targetReps}`));
    row.appendChild(el('div', { class: 'mono muted' }, `${ex.targetWeight} lb`));
    row.appendChild(el('button', { class: 'primary', on: { click: () => startSet(exIdx, setIdx) } }, 'Start'));
  } else {
    row.appendChild(el('div', { class: 'mono muted' }, `${ex.targetReps}`));
    row.appendChild(el('div', { class: 'mono muted' }, `${ex.targetWeight} lb`));
    row.appendChild(el('div', { class: 'pill' }, '–'));
  }
  return row;
}

let tickInterval = null;
function startTimerTick() {
  if (tickInterval) clearInterval(tickInterval);
  const update = () => {
    const node = document.getElementById('wktimer');
    if (!node || !state.active) return;
    node.textContent = fmtDuration(now() - state.active.startedAt);
  };
  update();
  tickInterval = setInterval(update, 1000);
}
function stopTimerTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

const CHATGPT_PROMPT = `You are generating a calisthenics workout for a tracker app. Your output MUST be a single valid JSON object that conforms exactly to the schema below. Output NOTHING ELSE — no commentary, no markdown code fences, no explanation, no leading or trailing text.

==============================================================
SCHEMA
==============================================================

Top-level: a JSON object with exactly two fields.

  name (string, REQUIRED)
    - Human-readable workout name shown in the app.
    - Must be non-empty after trimming whitespace.
    - Examples: "Push Day", "Full Body A", "Vest Conditioning".

  exercises (array of objects, REQUIRED)
    - Ordered list of exercises in the order they will be performed.
    - Must contain at least one element.

Each element of "exercises" is a JSON object with exactly four fields:

  name (string, REQUIRED)
    - Human-readable exercise name.
    - Must be non-empty after trimming whitespace.
    - If the exercise is an isometric hold, include the hold time in the name (e.g. "Plank, 60s hold", "L-sit, 20s hold").

  sets (integer, REQUIRED)
    - Number of sets to perform.
    - Must be a positive integer (>= 1).
    - Typical range: 2 to 5.

  reps (integer, REQUIRED)
    - Target reps PER SET. The same target applies to every set of this exercise.
    - Must be an integer >= 0.
    - Use 0 ONLY for isometric holds (where reps are not meaningful). For holds, the duration belongs in the name (see above).
    - Otherwise use a positive integer (e.g. 8, 12, 20).

  weight (number, REQUIRED)
    - Weighted-vest load in POUNDS (lbs). NOT kilograms.
    - Must be a number >= 0. Half-pounds are allowed (e.g. 17.5).
    - Use 0 if no vest is worn for that exercise.
    - This field is for VEST WEIGHT ONLY. The app is designed for bodyweight + weighted-vest training.
    - Do NOT use this field to represent dumbbells, barbells, kettlebells, plates, bands, or anything other than a worn vest.

==============================================================
CONTENT RULES
==============================================================

  - Calisthenics ONLY. Every exercise must be a bodyweight movement, optionally loaded with a weighted vest.
  - Allowed movement categories: push-ups and variants, pull-ups, chin-ups, muscle-ups, dips, inverted/bodyweight rows, bodyweight squats, lunges, split squats, pistol squats, step-ups, bodyweight hip thrusts and glute bridges, L-sits, planks, hollow holds, hanging leg raises, knee raises, mountain climbers, burpees, jump squats and plyometric variations, handstand holds and handstand push-ups, calf raises, bridges, dragon flags, archer and one-arm variations.
  - Disallowed: barbells, dumbbells, kettlebells, cable machines, resistance machines, medicine balls, sleds, sandbags, resistance bands as the primary load. The vest is the ONLY external load.
  - If a movement is conventionally loaded with external weight (e.g. "Goblet squat", "DB row"), substitute a bodyweight or vested variant (e.g. "Pistol squat", "Inverted row, vested").

==============================================================
JSON FORMAT RULES (STRICT)
==============================================================

  - Output must be parseable by JavaScript's JSON.parse() with no preprocessing.
  - Do NOT wrap the output in \`\`\`json ... \`\`\` code fences.
  - Do NOT include any prose before or after the JSON.
  - Do NOT include trailing commas.
  - Do NOT include comments (JSON does not support comments).
  - Use double quotes for all strings and field names. No single quotes.
  - All numeric values are JSON numbers — never quoted.
  - Do NOT add any fields that aren't in the schema above. Unknown fields will be ignored.
  - Field order does not matter, but every required field must be present on every object.

==============================================================
EXAMPLES (valid output)
==============================================================

Minimal valid output (one exercise, no vest):
{
  "name": "Quick Pull",
  "exercises": [
    {"name": "Pull-ups", "sets": 3, "reps": 8, "weight": 0}
  ]
}

Mixed bodyweight + vested workout:
{
  "name": "Push Day, Vested",
  "exercises": [
    {"name": "Push-ups", "sets": 4, "reps": 15, "weight": 20},
    {"name": "Dips", "sets": 3, "reps": 8, "weight": 20},
    {"name": "Pike push-ups", "sets": 3, "reps": 8, "weight": 0},
    {"name": "Plank, 60s hold", "sets": 3, "reps": 0, "weight": 20}
  ]
}

Full-body session with holds and plyometrics:
{
  "name": "Full Body A",
  "exercises": [
    {"name": "Pull-ups", "sets": 4, "reps": 6, "weight": 20},
    {"name": "Push-ups", "sets": 4, "reps": 20, "weight": 20},
    {"name": "Bulgarian split squats (per leg)", "sets": 3, "reps": 10, "weight": 0},
    {"name": "Inverted rows", "sets": 3, "reps": 12, "weight": 20},
    {"name": "Hollow hold, 30s hold", "sets": 3, "reps": 0, "weight": 0},
    {"name": "Burpees", "sets": 2, "reps": 15, "weight": 0}
  ]
}

==============================================================
YOUR TASK
==============================================================

Generate the workout described below. Respond with the JSON object ONLY, exactly matching the schema and rules above.

REQUEST:
[REPLACE THIS LINE with what you want. Examples of useful detail to include: total duration, focus area (push / pull / legs / full body / conditioning), available vest weight in lbs, difficulty level, any movements to avoid (injuries, equipment access), preferred rep ranges.]`;

async function copyChatGPTPrompt() {
  try {
    await navigator.clipboard.writeText(CHATGPT_PROMPT);
    toast('Prompt copied — paste into ChatGPT');
  } catch {
    // fallback for older iOS Safari
    const ta = document.createElement('textarea');
    ta.value = CHATGPT_PROMPT;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Prompt copied — paste into ChatGPT'); }
    catch { toast('Copy failed — long-press the prompt manually'); }
    ta.remove();
  }
}

async function savePaste() {
  state.pasteError = '';
  try {
    const routine = parseRoutine(state.pasteText);
    await db.saveRoutine(routine);
    state.routines = await db.listRoutines();
    state.pasteText = '';
    go('home');
    toast('Workout saved');
  } catch (e) {
    state.pasteError = e.message || String(e);
    render();
  }
}

async function removeRoutine(r) {
  if (!confirm(`Delete "${r.name}"?`)) return;
  await db.deleteRoutine(r.id);
  state.routines = await db.listRoutines();
  render();
}

function startWorkout(routine) {
  state.active = buildActive(routine);
  saveActive();
  acquireWakeLock();
  go('workout');
}

function startSet(exIdx, setIdx) {
  const a = state.active;
  a.exercises[exIdx].sets[setIdx].startedAt = now();
  saveActive();
  render();
}

function completeSet(exIdx, setIdx, repsVal, weightVal) {
  const a = state.active;
  const set = a.exercises[exIdx].sets[setIdx];
  set.reps = Number(repsVal) || 0;
  set.weight = Number(weightVal) || 0;
  set.endedAt = now();

  const ex = a.exercises[exIdx];
  if (setIdx + 1 < ex.sets.length) {
    a.currentSetIdx = setIdx + 1;
  }
  saveActive();
  render();
}

async function advanceExercise() {
  const a = state.active;
  if (a.currentExIdx + 1 < a.exercises.length) {
    a.currentExIdx += 1;
    a.currentSetIdx = 0;
    saveActive();
    render();
  } else {
    await finishWorkout();
  }
}

async function finishWorkout() {
  const a = state.active;
  a.endedAt = now();
  // strip transient fields
  const record = { ...a };
  delete record.currentExIdx;
  delete record.currentSetIdx;
  await db.saveWorkout(record);
  state.workouts = await db.listWorkouts();
  state.active = null;
  saveActive();
  releaseWakeLock();
  stopTimerTick();
  go('home');
  toast('Workout saved to history');
}

function cancelWorkout() {
  if (!confirm('Cancel this workout? Progress will be lost.')) return;
  state.active = null;
  saveActive();
  releaseWakeLock();
  stopTimerTick();
  go('home');
}

async function deleteHistoryEntry(w) {
  if (!confirm(`Delete workout from ${fmtDate(w.startedAt)}?`)) return;
  await db.deleteWorkout(w.id);
  state.workouts = await db.listWorkouts();
  go('history');
}

async function exportData() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workout-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function init() {
  state.routines = await db.listRoutines();
  state.workouts = await db.listWorkouts();
  state.active = loadActive();
  if (state.active) {
    state.view = 'workout';
    acquireWakeLock();
  }
  render();
}

init();
