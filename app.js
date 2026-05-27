import * as db from './db.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const ACTIVE_KEY = 'wt.active';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
const now = () => Date.now();

const state = {
  view: 'home',
  plans: [],
  workouts: [],
  active: null,
  selectedPlanId: null,
  selectedWorkoutId: null,
  pasteText: '',
  pasteError: '',
};

let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
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
  const s = Math.max(0, Math.floor(ms / 1000));
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

// ============================================================
// Parser
// ============================================================

const VALID_DAY_TYPES = ['workout', 'cardio', 'rest'];
const VALID_SECTION_TYPES = ['exercise', 'circuit', 'cardio', 'mobility'];

function requireString(v, where, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}: "${field}" must be a non-empty string.`);
  return v.trim();
}
function requirePositiveNumber(v, where, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${where}: "${field}" must be a positive number.`);
  return n;
}
function requireNonNegativeNumber(v, where, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${where}: "${field}" must be a non-negative number.`);
  return n;
}

function parsePlan(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  if (!data || typeof data !== 'object') throw new Error('Top-level must be a JSON object.');

  const name = requireString(data.name, 'plan', 'name');
  const duration_weeks = requirePositiveNumber(data.duration_weeks, 'plan', 'duration_weeks');

  if (!Array.isArray(data.days) || data.days.length === 0) {
    throw new Error('Plan needs a non-empty "days" array.');
  }
  const days = data.days.map((d, i) => parseDay(d, i));

  return { id: uid(), createdAt: now(), name, duration_weeks, days };
}

function parseDay(day, idx) {
  const where = `Day ${idx + 1}`;
  if (!day || typeof day !== 'object') throw new Error(`${where}: not an object.`);
  const dayNum = Number(day.day);
  if (!Number.isFinite(dayNum)) throw new Error(`${where}: "day" must be a number.`);
  const name = requireString(day.name, where, 'name');
  if (!VALID_DAY_TYPES.includes(day.type)) throw new Error(`${where} (${name}): "type" must be one of ${VALID_DAY_TYPES.join('|')}.`);
  const notes = typeof day.notes === 'string' ? day.notes : '';

  let sections = [];
  if (day.type !== 'rest') {
    if (!Array.isArray(day.sections) || day.sections.length === 0) {
      throw new Error(`${where} (${name}): non-rest day needs non-empty "sections" array.`);
    }
    sections = day.sections.map((s, si) => parseSection(s, idx, si));
  }

  return { day: dayNum, name, type: day.type, notes, sections };
}

function parseSection(s, di, si) {
  const where = `Day ${di + 1} section ${si + 1}`;
  if (!s || typeof s !== 'object') throw new Error(`${where}: not an object.`);
  const name = requireString(s.name, where, 'name');
  if (!VALID_SECTION_TYPES.includes(s.type)) {
    throw new Error(`${where} (${name}): "type" must be one of ${VALID_SECTION_TYPES.join('|')}.`);
  }
  const out = { name, type: s.type };

  if (s.type === 'circuit') {
    out.rounds = requirePositiveNumber(s.rounds, `${where} (${name})`, 'rounds');
    if (s.interval_seconds != null) {
      out.interval_seconds = requirePositiveNumber(s.interval_seconds, `${where} (${name})`, 'interval_seconds');
    }
    if (!Array.isArray(s.exercises) || s.exercises.length === 0) {
      throw new Error(`${where} (${name}): circuit needs non-empty "exercises" array.`);
    }
    out.exercises = s.exercises.map((ex, ei) => {
      const w = `${where} (${name}) exercise ${ei + 1}`;
      if (!ex || typeof ex !== 'object') throw new Error(`${w}: not an object.`);
      return {
        name: requireString(ex.name, w, 'name'),
        reps: requireNonNegativeNumber(ex.reps, w, 'reps'),
        weight: ex.weight == null ? 0 : requireNonNegativeNumber(ex.weight, w, 'weight'),
      };
    });
  } else if (s.type === 'exercise') {
    out.sets = requirePositiveNumber(s.sets, `${where} (${name})`, 'sets');
    out.reps = requireNonNegativeNumber(s.reps, `${where} (${name})`, 'reps');
    out.weight = s.weight == null ? 0 : requireNonNegativeNumber(s.weight, `${where} (${name})`, 'weight');
  } else if (s.type === 'cardio' || s.type === 'mobility') {
    if (s.duration_minutes != null) out.duration_minutes = requirePositiveNumber(s.duration_minutes, `${where} (${name})`, 'duration_minutes');
    if (s.distance_miles != null) out.distance_miles = requirePositiveNumber(s.distance_miles, `${where} (${name})`, 'distance_miles');
    if (s.target_intensity != null) {
      if (typeof s.target_intensity !== 'string') throw new Error(`${where} (${name}): "target_intensity" must be a string.`);
      out.target_intensity = s.target_intensity;
    }
    if (out.duration_minutes == null && out.distance_miles == null) {
      throw new Error(`${where} (${name}): cardio/mobility section needs duration_minutes or distance_miles.`);
    }
  }
  return out;
}

// ============================================================
// Active session
// ============================================================

function buildActive(plan, dayIdx) {
  const day = plan.days[dayIdx];
  const sections = day.sections.map(s => {
    const base = { ...s };
    if (s.type === 'circuit') {
      base.completedRounds = []; // [{startedAt, endedAt, exercises: [{reps, weight}]}]
      base.currentRoundStartedAt = null;
    } else if (s.type === 'exercise') {
      base.completedSets = []; // [{reps, weight, startedAt, endedAt}]
      base.currentSetStartedAt = null;
    } else if (s.type === 'cardio' || s.type === 'mobility') {
      base.timerStartedAt = null;
      base.timerEndedAt = null;
      base.actualMinutes = null;
      base.actualMiles = null;
    }
    base.completed = false;
    return base;
  });

  return {
    id: uid(),
    planId: plan.id,
    planName: plan.name,
    dayIndex: dayIdx,
    day: { day: day.day, name: day.name, type: day.type, notes: day.notes },
    sections,
    currentSectionIdx: 0,
    startedAt: now(),
    endedAt: null,
  };
}

function isSectionComplete(sec) {
  if (sec.completed) return true;
  if (sec.type === 'circuit') return sec.completedRounds.length >= sec.rounds;
  if (sec.type === 'exercise') return sec.completedSets.length >= sec.sets;
  if (sec.type === 'cardio' || sec.type === 'mobility') return sec.timerEndedAt != null;
  return false;
}

// ============================================================
// Routing
// ============================================================

function go(view, extra = {}) {
  state.view = view;
  Object.assign(state, extra);
  render();
}

function render() {
  stopAllTickers();
  const app = document.getElementById('app');
  app.replaceChildren();
  const view = views[state.view] || views.home;
  view(app);
}

// ============================================================
// Views
// ============================================================

const views = {
  home(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('div', { class: 'title' }, [el('h1', {}, 'Plans')]),
      el('button', { class: 'icon ghost', on: { click: () => go('history') } }, 'History'),
    ]));

    root.appendChild(el('button', { class: 'primary', on: { click: () => go('paste') } }, '+ Paste training plan'));

    if (state.active) {
      root.appendChild(el('div', { class: 'card current tap', on: { click: () => go('session') } }, [
        el('div', { class: 'muted' }, 'In progress'),
        el('div', { class: 'exercise-name' }, `${state.active.planName} — ${state.active.day.name}`),
        el('div', { class: 'muted' }, 'Tap to resume'),
      ]));
    }

    if (state.plans.length === 0) {
      root.appendChild(el('div', { class: 'empty' }, 'No plans yet. Paste a plan to begin.'));
    } else {
      const list = el('div', { class: 'list' });
      for (const p of state.plans) {
        list.appendChild(el('div', { class: 'card tap', on: { click: () => go('plan', { selectedPlanId: p.id }) } }, [
          el('div', { class: 'spread' }, [
            el('div', { class: 'exercise-name' }, p.name),
            el('button', { class: 'danger', on: { click: (e) => { e.stopPropagation(); removePlan(p); } } }, 'Delete'),
          ]),
          el('div', { class: 'muted' }, `${p.duration_weeks} weeks · ${p.days.length} days/week`),
        ]));
      }
      root.appendChild(list);
    }
  },

  paste(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('home') } }, '← Back'),
      el('div', { class: 'title' }, [el('h1', {}, 'Paste plan')]),
    ]));

    root.appendChild(el('p', { class: 'muted' }, 'Have ChatGPT build a training plan — copy the prompt, paste into ChatGPT, then paste its JSON output below.'));
    root.appendChild(el('button', { class: 'ghost', on: { click: () => copyChatGPTPrompt() } }, '📋 Copy ChatGPT prompt'));

    root.appendChild(el('p', { class: 'muted' }, 'Or paste plan JSON directly.'));

    const ta = el('textarea', {
      placeholder: 'Paste the full plan JSON here…',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    });
    ta.value = state.pasteText;
    ta.addEventListener('input', () => { state.pasteText = ta.value; });
    root.appendChild(ta);

    if (state.pasteError) root.appendChild(el('div', { class: 'error' }, state.pasteError));

    root.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'ghost', on: { click: () => { state.pasteText = ''; state.pasteError = ''; render(); } } }, 'Clear'),
      el('button', { class: 'primary', on: { click: () => savePaste() } }, 'Save'),
    ]));
  },

  plan(root) {
    const plan = state.plans.find(p => p.id === state.selectedPlanId);
    if (!plan) { go('home'); return; }

    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('home') } }, '← Back'),
      el('div', { class: 'title' }, [
        el('h1', {}, plan.name),
        el('div', { class: 'muted' }, `${plan.duration_weeks} weeks · ${plan.days.length} days/week`),
      ]),
    ]));

    if (state.active && state.active.planId === plan.id) {
      root.appendChild(el('div', { class: 'card current tap', on: { click: () => go('session') } }, [
        el('div', { class: 'muted' }, 'In progress'),
        el('div', { class: 'exercise-name' }, state.active.day.name),
        el('div', { class: 'muted' }, 'Tap to resume'),
      ]));
    }

    const list = el('div', { class: 'list' });
    plan.days.forEach((d, idx) => {
      list.appendChild(el('div', { class: 'card tap', on: { click: () => startDay(plan, idx) } }, [
        el('div', { class: 'spread' }, [
          el('div', {}, [
            el('div', { class: 'exercise-name' }, `Day ${d.day}: ${d.name}`),
            el('div', { class: 'target' }, daySummary(d)),
          ]),
          el('span', { class: 'pill' }, d.type),
        ]),
        d.notes ? el('div', { class: 'muted' }, d.notes) : null,
      ]));
    });
    root.appendChild(list);
  },

  session(root) {
    const a = state.active;
    if (!a) { go('home'); return; }

    root.appendChild(el('div', { class: 'header' }, [
      el('div', { class: 'title' }, [
        el('h1', {}, a.day.name),
        el('div', { class: 'muted' }, [
          el('span', {}, `${a.planName} · `),
          el('span', { class: 'timer', id: 'wktimer' }, '0:00'),
        ]),
      ]),
      el('button', { class: 'danger', on: { click: () => cancelSession() } }, 'Cancel'),
    ]));

    if (a.day.notes) root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'muted' }, a.day.notes)]));

    if (a.day.type === 'rest') {
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'exercise-name' }, 'Rest day'),
        el('div', { class: 'muted' }, 'No work today. Mark complete when you\'re done resting (or skip entirely).'),
        el('button', { class: 'primary', on: { click: () => finishSession() } }, 'Mark rest day complete'),
      ]));
      startWorkoutTimer();
      return;
    }

    a.sections.forEach((sec, si) => {
      const isCurrent = si === a.currentSectionIdx;
      const isDone = isSectionComplete(sec);

      const card = el('div', { class: 'card' + (isCurrent && !isDone ? ' current' : '') });
      card.appendChild(el('div', { class: 'spread' }, [
        el('div', {}, [
          el('div', { class: 'exercise-name' }, sec.name),
          el('div', { class: 'target' }, sectionSummary(sec)),
        ]),
        el('span', { class: 'pill' }, sec.type),
      ]));

      if (isDone) {
        card.classList.add('done-section');
        card.appendChild(el('div', { class: 'muted' }, '✓ done'));
      } else if (isCurrent) {
        if (sec.type === 'circuit') renderCircuit(card, sec, si);
        else if (sec.type === 'exercise') renderExercise(card, sec, si);
        else if (sec.type === 'cardio' || sec.type === 'mobility') renderCardio(card, sec, si);
      } else {
        card.appendChild(el('div', { class: 'muted' }, 'Up next'));
      }

      root.appendChild(card);
    });

    startWorkoutTimer();
  },

  history(root) {
    root.appendChild(el('div', { class: 'header' }, [
      el('button', { class: 'icon ghost', on: { click: () => go('home') } }, '← Back'),
      el('div', { class: 'title' }, [el('h1', {}, 'History')]),
      el('button', { class: 'icon ghost', on: { click: () => exportData() } }, 'Export'),
    ]));

    if (state.workouts.length === 0) {
      root.appendChild(el('div', { class: 'empty' }, 'No completed sessions yet.'));
      return;
    }

    const list = el('div', { class: 'list' });
    for (const w of state.workouts) {
      const dur = w.endedAt ? w.endedAt - w.startedAt : null;
      list.appendChild(el('div', { class: 'card tap', on: { click: () => go('workoutDetail', { selectedWorkoutId: w.id }) } }, [
        el('div', { class: 'spread' }, [
          el('div', { class: 'exercise-name' }, `${w.planName} — ${w.day.name}`),
          el('div', { class: 'pill' }, fmtDuration(dur)),
        ]),
        el('div', { class: 'muted' }, `${fmtDate(w.startedAt)} · ${w.day.type}`),
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
        el('h1', {}, `${w.planName} — ${w.day.name}`),
        el('div', { class: 'muted' }, `${fmtDate(w.startedAt)} · ${fmtDuration(dur)}`),
      ]),
      el('button', { class: 'danger', on: { click: () => deleteHistoryEntry(w) } }, 'Delete'),
    ]));

    if (w.day.notes) root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'muted' }, w.day.notes)]));

    if (w.day.type === 'rest') {
      root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'muted' }, 'Rest day — marked complete.')]));
      return;
    }

    for (const sec of (w.sections || [])) {
      const card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'spread' }, [
        el('div', { class: 'exercise-name' }, sec.name),
        el('span', { class: 'pill' }, sec.type),
      ]));

      if (sec.type === 'circuit') {
        card.appendChild(el('div', { class: 'muted' }, `${sec.completedRounds.length} / ${sec.rounds} rounds`));
        const totalsByEx = {};
        for (const r of sec.completedRounds) {
          for (const ex of r.exercises) {
            totalsByEx[ex.name] = (totalsByEx[ex.name] || 0) + (ex.reps || 0);
          }
        }
        const totals = el('div', { class: 'col' });
        for (const [name, reps] of Object.entries(totalsByEx)) {
          totals.appendChild(el('div', { class: 'set-row done' }, [
            el('div', { class: 'label' }, '∑'),
            el('div', { class: 'mono' }, name),
            el('div', { class: 'mono' }, `${reps} reps`),
            el('div', { class: 'pill' }, ''),
          ]));
        }
        card.appendChild(totals);
      } else if (sec.type === 'exercise') {
        const list = el('div', { class: 'col' });
        sec.completedSets.forEach((s, si) => {
          list.appendChild(el('div', { class: 'set-row done' }, [
            el('div', { class: 'label' }, `${si + 1}`),
            el('div', { class: 'mono' }, `${s.reps ?? '–'} reps`),
            el('div', { class: 'mono' }, `${s.weight ?? 0} lb`),
            el('div', { class: 'pill' }, s.endedAt && s.startedAt ? fmtDuration(s.endedAt - s.startedAt) : '–'),
          ]));
        });
        card.appendChild(list);
      } else if (sec.type === 'cardio' || sec.type === 'mobility') {
        const dm = sec.timerEndedAt && sec.timerStartedAt ? sec.timerEndedAt - sec.timerStartedAt : null;
        card.appendChild(el('div', { class: 'col' }, [
          el('div', { class: 'muted' }, `Elapsed: ${fmtDuration(dm)}`),
          sec.actualMinutes != null ? el('div', { class: 'muted' }, `Logged: ${sec.actualMinutes} min`) : null,
          sec.actualMiles != null ? el('div', { class: 'muted' }, `Distance: ${sec.actualMiles} mi`) : null,
        ]));
      }
      root.appendChild(card);
    }
  },
};

// ============================================================
// Summaries
// ============================================================

function daySummary(day) {
  if (day.type === 'rest') return 'Rest';
  return day.sections.map(s => sectionSummary(s)).join(' · ');
}

function sectionSummary(s) {
  if (s.type === 'circuit') {
    const exs = s.exercises.map(e => `${e.reps} ${e.name}${e.weight ? ` @${e.weight}lb` : ''}`).join(' / ');
    const iv = s.interval_seconds ? ` every ${fmtDuration(s.interval_seconds * 1000)}` : '';
    return `${s.rounds} rounds${iv}: ${exs}`;
  }
  if (s.type === 'exercise') {
    return `${s.sets} × ${s.reps}${s.weight ? ` @${s.weight}lb` : ''}`;
  }
  if (s.type === 'cardio' || s.type === 'mobility') {
    const parts = [];
    if (s.duration_minutes != null) parts.push(`${s.duration_minutes} min`);
    if (s.distance_miles != null) parts.push(`${s.distance_miles} mi`);
    if (s.target_intensity) parts.push(s.target_intensity);
    return parts.join(' · ');
  }
  return '';
}

// ============================================================
// Section renderers (active session)
// ============================================================

function renderCircuit(card, sec, si) {
  const roundIdx = sec.completedRounds.length; // next round to do (0-indexed)
  const totalRounds = sec.rounds;
  const inRound = sec.currentRoundStartedAt != null;

  card.appendChild(el('div', { class: 'big-stat' }, [
    el('div', { class: 'big-stat-label' }, 'Round'),
    el('div', { class: 'big-stat-value' }, `${roundIdx + (inRound ? 1 : (roundIdx < totalRounds ? 1 : totalRounds))} / ${totalRounds}`),
  ]));

  // Interval pacing display
  if (sec.interval_seconds && sec.completedRounds.length > 0 && !inRound) {
    const lastRoundStart = sec.completedRounds[sec.completedRounds.length - 1].startedAt;
    const nextTargetAt = lastRoundStart + sec.interval_seconds * 1000;
    const intervalNode = el('div', { class: 'interval', id: `interval-${si}` });
    card.appendChild(intervalNode);
    updateIntervalDisplay(intervalNode, nextTargetAt);
    startIntervalTicker(si, nextTargetAt);
  }

  const exList = el('div', { class: 'col' });
  const repInputs = [];
  sec.exercises.forEach((ex) => {
    const repsIn = el('input', { type: 'number', inputmode: 'numeric', value: String(ex.reps), min: '0' });
    repInputs.push({ ex, input: repsIn });
    exList.appendChild(el('div', { class: 'set-row' + (inRound ? ' active' : '') }, [
      el('div', { class: 'label mono' }, `${ex.reps}×`),
      el('div', { class: 'mono', style: 'text-align:left' }, ex.name),
      repsIn,
      el('div', { class: 'pill' }, ex.weight ? `${ex.weight}lb` : 'BW'),
    ]));
  });
  card.appendChild(exList);

  if (!inRound) {
    card.appendChild(el('button', { class: 'primary', on: { click: () => startCircuitRound(si) } }, `Start round ${roundIdx + 1}`));
  } else {
    card.appendChild(el('button', { class: 'primary', on: {
      click: () => completeCircuitRound(si, repInputs.map(r => ({ name: r.ex.name, reps: Number(r.input.value) || 0, weight: r.ex.weight }))),
    } }, `Round ${roundIdx + 1} complete`));
  }
}

function renderExercise(card, sec, si) {
  const setIdx = sec.completedSets.length;
  const inSet = sec.currentSetStartedAt != null;

  card.appendChild(el('div', { class: 'col' }, [
    // Show completed sets
    ...sec.completedSets.map((s, idx) => el('div', { class: 'set-row done' }, [
      el('div', { class: 'label' }, `${idx + 1}`),
      el('div', { class: 'mono' }, `${s.reps} reps`),
      el('div', { class: 'mono' }, `${s.weight} lb`),
      el('div', { class: 'pill' }, fmtDuration(s.endedAt - s.startedAt)),
    ])),
  ]));

  if (setIdx < sec.sets) {
    if (inSet) {
      const repsIn = el('input', { type: 'number', inputmode: 'numeric', value: String(sec.reps), min: '0' });
      const wtIn = el('input', { type: 'number', inputmode: 'decimal', value: String(sec.weight), min: '0', step: '0.5' });
      card.appendChild(el('div', { class: 'set-row active' }, [
        el('div', { class: 'label' }, `${setIdx + 1}`),
        repsIn,
        wtIn,
        el('button', { class: 'primary', on: { click: () => completeExerciseSet(si, repsIn.value, wtIn.value) } }, 'Done'),
      ]));
    } else {
      card.appendChild(el('div', { class: 'set-row' }, [
        el('div', { class: 'label' }, `${setIdx + 1}`),
        el('div', { class: 'mono muted' }, `${sec.reps}`),
        el('div', { class: 'mono muted' }, `${sec.weight} lb`),
        el('button', { class: 'primary', on: { click: () => startExerciseSet(si) } }, 'Start'),
      ]));
    }
  }
}

function renderCardio(card, sec, si) {
  const inProgress = sec.timerStartedAt && !sec.timerEndedAt;
  const done = sec.timerEndedAt != null;

  if (!sec.timerStartedAt) {
    card.appendChild(el('button', { class: 'primary', on: { click: () => startCardio(si) } }, 'Start timer'));
    return;
  }

  const timerNode = el('div', { class: 'big-stat' }, [
    el('div', { class: 'big-stat-label' }, sec.type === 'mobility' ? 'Mobility' : 'Cardio'),
    el('div', { class: 'big-stat-value timer', id: `cardio-${si}` }, '0:00'),
  ]);
  card.appendChild(timerNode);

  if (inProgress) {
    startCardioTicker(si);
    card.appendChild(el('button', { class: 'primary', on: { click: () => stopCardio(si) } }, 'Stop'));
  } else if (done) {
    const elapsedMs = sec.timerEndedAt - sec.timerStartedAt;
    document.getElementById(`cardio-${si}`).textContent = fmtDuration(elapsedMs);

    const minsIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.1', placeholder: 'Actual minutes', value: sec.actualMinutes != null ? String(sec.actualMinutes) : String(Math.round(elapsedMs / 60000)) });
    const milesIn = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Actual miles', value: sec.actualMiles != null ? String(sec.actualMiles) : '' });
    card.appendChild(el('div', { class: 'row' }, [minsIn, milesIn]));
    card.appendChild(el('button', { class: 'primary', on: { click: () => finishCardio(si, minsIn.value, milesIn.value) } }, 'Save & continue'));
  }
}

// ============================================================
// Timers
// ============================================================

let workoutTicker = null;
function startWorkoutTimer() {
  if (workoutTicker) clearInterval(workoutTicker);
  const update = () => {
    const node = document.getElementById('wktimer');
    if (!node || !state.active) return;
    node.textContent = fmtDuration(now() - state.active.startedAt);
  };
  update();
  workoutTicker = setInterval(update, 1000);
}

const intervalTickers = new Map();
function startIntervalTicker(si, nextTargetAt) {
  stopIntervalTicker(si);
  const update = () => {
    const node = document.getElementById(`interval-${si}`);
    if (!node) { stopIntervalTicker(si); return; }
    updateIntervalDisplay(node, nextTargetAt);
  };
  const t = setInterval(update, 250);
  intervalTickers.set(si, t);
}
function stopIntervalTicker(si) {
  if (intervalTickers.has(si)) { clearInterval(intervalTickers.get(si)); intervalTickers.delete(si); }
}
function updateIntervalDisplay(node, targetAt) {
  const remaining = targetAt - now();
  if (remaining > 0) {
    node.textContent = `Next round in ${fmtDuration(remaining)}`;
    node.classList.remove('overdue');
    node.classList.add('countdown');
  } else {
    node.textContent = `Behind by ${fmtDuration(-remaining)} — start now`;
    node.classList.add('overdue');
    node.classList.remove('countdown');
  }
}

const cardioTickers = new Map();
function startCardioTicker(si) {
  stopCardioTicker(si);
  const sec = state.active.sections[si];
  const update = () => {
    const node = document.getElementById(`cardio-${si}`);
    if (!node) { stopCardioTicker(si); return; }
    node.textContent = fmtDuration(now() - sec.timerStartedAt);
  };
  update();
  const t = setInterval(update, 1000);
  cardioTickers.set(si, t);
}
function stopCardioTicker(si) {
  if (cardioTickers.has(si)) { clearInterval(cardioTickers.get(si)); cardioTickers.delete(si); }
}

function stopAllTickers() {
  if (workoutTicker) { clearInterval(workoutTicker); workoutTicker = null; }
  for (const t of intervalTickers.values()) clearInterval(t);
  intervalTickers.clear();
  for (const t of cardioTickers.values()) clearInterval(t);
  cardioTickers.clear();
}

// ============================================================
// Actions
// ============================================================

const CHATGPT_PROMPT = `You are generating a multi-week calisthenics training plan for a tracker app. Your output MUST be a single valid JSON object that conforms exactly to the schema below. Output NOTHING ELSE — no commentary, no markdown code fences, no explanation, no leading or trailing text.

==============================================================
TOP-LEVEL SCHEMA
==============================================================

{
  "name": <string, REQUIRED>,
  "duration_weeks": <integer, REQUIRED, >= 1>,
  "days": [ <Day>, <Day>, ... ]   // REQUIRED, non-empty, ordered
}

  name                Human-readable plan name. Non-empty.
  duration_weeks      How many weeks the plan runs. The "days" array is a weekly template that repeats for this many weeks.
  days                Ordered weekly template. Typically 7 entries, one per weekday, but the count is up to you.

==============================================================
Day SCHEMA
==============================================================

{
  "day": <integer, REQUIRED>,           // 1-based position in the week (1..7 typically)
  "name": <string, REQUIRED>,           // Human-readable day name, e.g. "Hard Murph Day", "Rest"
  "type": <"workout" | "cardio" | "rest">,   // REQUIRED
  "notes": <string, OPTIONAL>,          // Coaching cues, pacing, intent. Empty string allowed.
  "sections": [ <Section>, ... ]        // REQUIRED if type != "rest". Omit or empty if type == "rest".
}

  type:
    "workout"  — strength, circuits, or mixed work. Must have sections.
    "cardio"   — purely cardio day (still uses sections, just cardio sections).
    "rest"     — no work. sections is omitted or empty.

==============================================================
Section SCHEMA
==============================================================

A section is one block within a day. Day has one or more sections in the order performed.

{
  "name": <string, REQUIRED>,           // e.g. "Murph Rounds", "Run", "Core Circuit", "Pull-ups"
  "type": <"exercise" | "circuit" | "cardio" | "mobility">,   // REQUIRED
  ... type-specific fields below
}

== type == "exercise" ==
Single exercise performed for sets × reps, with optional vest load.
{
  "name": "Pull-ups",
  "type": "exercise",
  "sets":   <integer, REQUIRED, >= 1>,
  "reps":   <integer, REQUIRED, >= 0>,     // target reps per set; 0 only for isometric holds (encode hold time in name, e.g. "Plank, 60s hold")
  "weight": <number, OPTIONAL, >= 0>       // vest weight in LBS. Default 0 if omitted. Half-lbs allowed.
}

== type == "circuit" ==
Multiple exercises performed in a round, repeated for N rounds. Optionally interval-paced.
{
  "name": "Murph Rounds",
  "type": "circuit",
  "rounds":           <integer, REQUIRED, >= 1>,
  "interval_seconds": <integer, OPTIONAL, > 0>,    // If set, user starts a new round every N seconds (EMOM-style pacing).
  "exercises": [                                    // REQUIRED, non-empty, in round order
    {
      "name":   <string, REQUIRED>,
      "reps":   <integer, REQUIRED, >= 0>,
      "weight": <number, OPTIONAL, >= 0>            // vest lbs, default 0
    },
    ...
  ]
}

== type == "cardio" or "mobility" ==
A time- or distance-based block. Must include at least one of duration_minutes or distance_miles.
{
  "name": "Easy cardio",
  "type": "cardio",                                  // or "mobility"
  "duration_minutes": <number, OPTIONAL, > 0>,
  "distance_miles":   <number, OPTIONAL, > 0>,
  "target_intensity": <string, OPTIONAL>             // free-form: "zone_2", "moderate", "easy", "tempo", etc.
}

==============================================================
CONTENT RULES
==============================================================

  - Calisthenics ONLY. Every strength exercise must be a bodyweight movement, optionally loaded with a weighted VEST.
  - The "weight" field is VEST WEIGHT in pounds. Never use it for dumbbells, barbells, kettlebells, bands, sleds, etc. — those are not supported.
  - Allowed strength movements: push-ups and variants, pull-ups, chin-ups, muscle-ups, dips, inverted/bodyweight rows, bodyweight squats, lunges, split squats, pistol squats, step-ups, glute bridges, hip thrusts (bodyweight), L-sits, planks, hollow holds, hanging leg raises, knee raises, mountain climbers, burpees, jump squats and plyo variations, handstand holds and push-ups, calf raises, bridges, dragon flags, archer / one-arm variations.
  - Disallowed: barbells, dumbbells, kettlebells, cables, resistance machines, sandbags, sleds. (Vest is the only external load.)
  - Cardio sections can be running, biking, rowing, rucking, etc. (no equipment constraint — just describe the activity in the section name and target_intensity).

==============================================================
JSON FORMAT RULES (STRICT)
==============================================================

  - Output must be parseable by JSON.parse() with no preprocessing.
  - Do NOT wrap output in \`\`\`json ... \`\`\` fences.
  - No prose before or after the JSON.
  - No trailing commas. No comments. Double quotes only.
  - All numbers are JSON numbers (unquoted).
  - Do NOT add fields not listed in this schema.
  - Field order does not matter, but every REQUIRED field must be present on every object.

==============================================================
FULL VALID EXAMPLE
==============================================================

{
  "name": "4-Week Murph Conditioning Plan",
  "duration_weeks": 4,
  "days": [
    {
      "day": 1,
      "name": "Hard Murph Day",
      "type": "workout",
      "notes": "Push the pace. Only all-out Murph-style day of the week.",
      "sections": [
        {
          "name": "Run",
          "type": "cardio",
          "distance_miles": 1,
          "target_intensity": "moderate"
        },
        {
          "name": "Murph Rounds",
          "type": "circuit",
          "rounds": 20,
          "exercises": [
            {"name": "Pull-ups",          "reps": 5,  "weight": 0},
            {"name": "Push-ups",          "reps": 10, "weight": 0},
            {"name": "Bodyweight squats", "reps": 15, "weight": 0}
          ]
        },
        {
          "name": "Run",
          "type": "cardio",
          "distance_miles": 1,
          "target_intensity": "moderate"
        }
      ]
    },
    {
      "day": 2,
      "name": "Easy Zone 2",
      "type": "cardio",
      "notes": "Easy enough to hold a conversation.",
      "sections": [
        {"name": "Easy cardio", "type": "cardio", "duration_minutes": 40, "target_intensity": "zone_2"}
      ]
    },
    {
      "day": 3,
      "name": "Controlled Murph Volume",
      "type": "workout",
      "notes": "Do not race. One round every 2:15.",
      "sections": [
        {
          "name": "Controlled Murph Rounds",
          "type": "circuit",
          "rounds": 20,
          "interval_seconds": 135,
          "exercises": [
            {"name": "Pull-ups",          "reps": 5,  "weight": 0},
            {"name": "Push-ups",          "reps": 10, "weight": 0},
            {"name": "Bodyweight squats", "reps": 15, "weight": 0}
          ]
        }
      ]
    },
    {"day": 4, "name": "Rest / Mobility", "type": "rest", "notes": "Walk or stretch. No Murph."},
    {
      "day": 5,
      "name": "Vest Stamina",
      "type": "workout",
      "notes": "Controlled pace.",
      "sections": [
        {
          "name": "Vested Conditioning",
          "type": "circuit",
          "rounds": 20,
          "interval_seconds": 120,
          "exercises": [
            {"name": "Pull-ups",          "reps": 4,  "weight": 20},
            {"name": "Push-ups",          "reps": 8,  "weight": 20},
            {"name": "Bodyweight squats", "reps": 12, "weight": 20}
          ]
        }
      ]
    },
    {
      "day": 6,
      "name": "Zone 2 + Core",
      "type": "workout",
      "sections": [
        {"name": "Easy cardio", "type": "cardio", "duration_minutes": 50, "target_intensity": "zone_2"},
        {
          "name": "Core Circuit",
          "type": "circuit",
          "rounds": 3,
          "exercises": [
            {"name": "Bicycle crunches",       "reps": 40, "weight": 0},
            {"name": "Lying ankle touches",    "reps": 40, "weight": 0},
            {"name": "Hollow hold, 40s hold",  "reps": 0,  "weight": 0},
            {"name": "Dead bugs (per side)",   "reps": 10, "weight": 0}
          ]
        }
      ]
    },
    {"day": 7, "name": "Rest", "type": "rest", "notes": "Full rest or walking only."}
  ]
}

==============================================================
YOUR TASK
==============================================================

Now produce the JSON for the plan/workout we've been discussing in this conversation. If we haven't yet pinned down a specific plan, ask me what I want first; otherwise just output the JSON.

Respond with the JSON object ONLY — no commentary, no markdown fences, no explanation. Just the raw JSON.`;

async function copyChatGPTPrompt() {
  try {
    await navigator.clipboard.writeText(CHATGPT_PROMPT);
    toast('Prompt copied — paste into ChatGPT');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = CHATGPT_PROMPT;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Prompt copied — paste into ChatGPT'); }
    catch { toast('Copy failed — long-press to copy'); }
    ta.remove();
  }
}

async function savePaste() {
  state.pasteError = '';
  try {
    const plan = parsePlan(state.pasteText);
    await db.savePlan(plan);
    state.plans = await db.listPlans();
    state.pasteText = '';
    go('home');
    toast('Plan saved');
  } catch (e) {
    state.pasteError = e.message || String(e);
    render();
  }
}

async function removePlan(p) {
  if (!confirm(`Delete plan "${p.name}"?`)) return;
  await db.deletePlan(p.id);
  state.plans = await db.listPlans();
  render();
}

function startDay(plan, dayIdx) {
  if (state.active) {
    if (!confirm('A session is already in progress. Start this one instead? Current progress will be lost.')) return;
  }
  state.active = buildActive(plan, dayIdx);
  saveActive();
  acquireWakeLock();
  go('session');
}

function startCircuitRound(si) {
  const sec = state.active.sections[si];
  sec.currentRoundStartedAt = now();
  saveActive();
  render();
}

function completeCircuitRound(si, exercisesLog) {
  const sec = state.active.sections[si];
  const started = sec.currentRoundStartedAt || now();
  sec.completedRounds.push({ startedAt: started, endedAt: now(), exercises: exercisesLog });
  sec.currentRoundStartedAt = null;
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function startExerciseSet(si) {
  const sec = state.active.sections[si];
  sec.currentSetStartedAt = now();
  saveActive();
  render();
}

function completeExerciseSet(si, repsVal, weightVal) {
  const sec = state.active.sections[si];
  const started = sec.currentSetStartedAt || now();
  sec.completedSets.push({
    reps: Number(repsVal) || 0,
    weight: Number(weightVal) || 0,
    startedAt: started,
    endedAt: now(),
  });
  sec.currentSetStartedAt = null;
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function startCardio(si) {
  const sec = state.active.sections[si];
  sec.timerStartedAt = now();
  saveActive();
  render();
}

function stopCardio(si) {
  const sec = state.active.sections[si];
  sec.timerEndedAt = now();
  saveActive();
  render();
}

function finishCardio(si, minsVal, milesVal) {
  const sec = state.active.sections[si];
  sec.actualMinutes = minsVal === '' || minsVal == null ? null : Number(minsVal);
  sec.actualMiles = milesVal === '' || milesVal == null ? null : Number(milesVal);
  sec.completed = true;
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function maybeAdvanceSection(si) {
  const a = state.active;
  if (!isSectionComplete(a.sections[si])) return;
  if (si === a.currentSectionIdx && si + 1 < a.sections.length) {
    a.currentSectionIdx = si + 1;
  }
  saveActive();
}

async function finishSession() {
  const a = state.active;
  a.endedAt = now();
  const record = { ...a };
  delete record.currentSectionIdx;
  await db.saveWorkout(record);
  state.workouts = await db.listWorkouts();
  state.active = null;
  saveActive();
  releaseWakeLock();
  stopAllTickers();
  go('home');
  toast('Session saved to history');
}

function cancelSession() {
  if (!confirm('Cancel this session? Progress will be lost.')) return;
  state.active = null;
  saveActive();
  releaseWakeLock();
  stopAllTickers();
  go('home');
}

async function deleteHistoryEntry(w) {
  if (!confirm(`Delete session from ${fmtDate(w.startedAt)}?`)) return;
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

// Detect "all sections complete" and surface Finish button as a floating action
function renderFinishButton(root) {
  const a = state.active;
  if (!a || a.day.type === 'rest') return;
  const allDone = a.sections.every(isSectionComplete);
  if (!allDone) return;
  root.appendChild(el('button', { class: 'primary', on: { click: () => finishSession() } }, 'Finish session'));
}

// Patch session view to include finish button at the bottom
const _origSession = views.session;
views.session = function(root) {
  _origSession(root);
  renderFinishButton(root);
};

// ============================================================
// Init
// ============================================================

async function init() {
  state.plans = await db.listPlans();
  state.workouts = await db.listWorkouts();
  state.active = loadActive();
  if (state.active) {
    state.view = 'session';
    acquireWakeLock();
  }
  render();
}

init();
