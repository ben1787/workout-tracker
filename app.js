import { requireAccount } from './cloud.js';
import { trackingFor, trackingResult } from './tracking.js';
import * as db from './db.js';
import { buildAIContext } from './ai-context.js';
import { requestAI } from './ai-api.js';
import { createExercise, linkExerciseRecords, findExercise } from './exercise-catalog.js';
import { workoutDuration } from './corrections.js';
import { weeklyProgress, exerciseProgress, workoutMetrics, exerciseAtLoad } from './progress.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

const ACTIVE_KEY = 'wt.active';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
const now = () => Date.now();

const state = {
  view: 'home',
  plans: [],
  goals: [],
  exercises: [],
  exerciseError: '',
  goalEditing: null,
  goalError: '',
  generating: false,
  generationError: '',
  chatting: false,
  revising: false,
  revisionError: '',
  feedback: loadJSON('wt.feedback', ''),
  aiReady: null,
  today: loadJSON('wt.today', { minutes: 45, equipment: '', limitations: '', feeling: '' }),
  draft: loadJSON('wt.draft', null),
  workouts: [],
  active: null,
  expandedWorkoutId: null,
  progressWorkoutId: null,
  reviewing: new Set(),
  reviewErrors: {},
  progressExercise: '',
  progressMetric: 'reps',
  progressLoad: 'all',
  finishing: false,
  finishError: '',
  correcting: new Set(),
  correctionErrors: {},
  correctionMessages: {},
  correctionInputs: loadJSON('wt.correctionInputs', {}),
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

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

const VALID_DAY_TYPES = ['workout', 'cardio', 'mobility', 'rest'];
const VALID_SECTION_TYPES = ['exercise', 'circuit', 'cardio', 'warmup', 'cooldown', 'mobility'];
const TIMER_SECTION_TYPES = ['cardio', 'mobility', 'warmup', 'cooldown'];

// Helpers that treat 0 / null / undefined as "field not present" — matches the
// schema convention of "use 0 for numeric fields that do not apply".
function posOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function nonNegOrZero(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function requireString(v, where, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}: "${field}" must be a non-empty string.`);
  return v.trim();
}
function requirePositiveNumber(v, where, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${where}: "${field}" must be a positive number.`);
  return n;
}

function parseDay(day, idx) {
  const where = `Day ${idx + 1}`;
  if (!day || typeof day !== 'object') throw new Error(`${where}: not an object.`);
  const dayNum = Number(day.day);
  if (!Number.isFinite(dayNum)) throw new Error(`${where}: "day" must be a number.`);
  const name = requireString(day.day_name ?? day.name, where, 'day_name');
  if (!VALID_DAY_TYPES.includes(day.type)) throw new Error(`${where} (${name}): "type" must be one of ${VALID_DAY_TYPES.join('|')}.`);
  const notes = typeof day.notes === 'string' ? day.notes : '';

  let sections = [];
  if (day.type !== 'rest') {
    if (!Array.isArray(day.sections) || day.sections.length === 0) {
      throw new Error(`${where} (${name}): non-rest day needs non-empty "sections" array.`);
    }
    sections = day.sections.map((s, si) => parseSection(s, idx, si));
  }

  return { day: dayNum, name, type: day.type, notes, summary: typeof day.summary === 'string' ? day.summary : '', sections };
}

function parseSection(s, di, si) {
  const where = `Day ${di + 1} section ${si + 1}`;
  if (!s || typeof s !== 'object') throw new Error(`${where}: not an object.`);
  const name = requireString(s.section_name ?? s.name, where, 'section_name');
  if (!VALID_SECTION_TYPES.includes(s.type)) {
    throw new Error(`${where} (${name}): "type" must be one of ${VALID_SECTION_TYPES.join('|')}.`);
  }
  const out = { name, youtubeUrl: s.youtubeUrl || s.youtube_url || '', type: s.type, tracking: s.tracking, exerciseId: s.exerciseId || s.exercise_id || null, instructions: typeof s.instructions === 'string' ? s.instructions : '', why: typeof s.why === 'string' ? s.why : '' };

  if (s.type === 'circuit') {
    const rounds = posOrNull(s.rounds);
    if (!rounds) throw new Error(`${where} (${name}): circuit needs "rounds" > 0.`);
    out.rounds = rounds;
    const iv = posOrNull(s.interval_seconds);
    if (iv) out.interval_seconds = iv;
    const rest = posOrNull(s.rest_seconds);
    if (rest) out.rest_seconds = rest;
    if (!Array.isArray(s.exercises) || s.exercises.length === 0) {
      throw new Error(`${where} (${name}): circuit needs non-empty "exercises" array.`);
    }
    out.exercises = s.exercises.map((ex, ei) => parseExerciseEntry(ex, `${where} (${name}) exercise ${ei + 1}`));
  } else if (s.type === 'exercise') {
    const sets = posOrNull(s.sets);
    if (!sets) throw new Error(`${where} (${name}): exercise section needs "sets" > 0.`);
    out.sets = sets;
    const rest = posOrNull(s.rest_seconds);
    if (rest) out.rest_seconds = rest;
    if (!Array.isArray(s.exercises) || s.exercises.length === 0) {
      throw new Error(`${where} (${name}): exercise section needs "exercises" with at least one entry.`);
    }
    // Use the first exercise entry; extras are ignored. Use circuit type for multi-exercise blocks.
    const first = parseExerciseEntry(s.exercises[0], `${where} (${name}) exercise 1`);
    out.exerciseName = first.name;
    out.exerciseId = first.exerciseId; out.holdSeconds = first.holdSeconds;
    out.youtubeUrl = first.youtubeUrl || out.youtubeUrl; out.exerciseInstructions = first.instructions; out.tracking = first.tracking;
    out.reps = first.reps;
    out.weight = first.weight;
  } else if (TIMER_SECTION_TYPES.includes(s.type)) {
    const dm = posOrNull(s.duration_minutes);
    if (dm) out.duration_minutes = dm;
    const dist = posOrNull(s.distance_miles);
    if (dist) out.distance_miles = dist;
    if (typeof s.target_intensity === 'string' && s.target_intensity.trim()) {
      out.target_intensity = s.target_intensity.trim();
    }
    // No required positive numeric — section becomes a freeform timer if nothing given.
  }
  return out;
}

function parseExerciseEntry(ex, where) {
  if (!ex || typeof ex !== 'object') throw new Error(`${where}: not an object.`);
  const name = requireString(ex.name, where, 'name');
  const reps = nonNegOrZero(ex.reps);
  const weight = nonNegOrZero(ex.weight);
  return { name, youtubeUrl: ex.youtubeUrl || ex.youtube_url || '', tracking: ex.tracking, exerciseId: ex.exerciseId || ex.exercise_id || null, holdSeconds: nonNegOrZero(ex.holdSeconds ?? ex.hold_seconds), reps, weight, instructions: typeof ex.instructions === 'string' ? ex.instructions : '' };
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
    } else if (TIMER_SECTION_TYPES.includes(s.type)) {
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
    day: { day: day.day, name: day.name, type: day.type, notes: day.notes, summary: day.summary },
    sections,
    currentSectionIdx: 0,
    startedAt: null, // set on first user action (start round / start set / start timer / skip / finish)
    endedAt: null,
  };
}

function armSession() {
  if (state.active && state.active.startedAt == null) {
    state.active.startedAt = now();
  }
}

function isSectionComplete(sec) {
  if (sec.completed) return true;
  if (sec.type === 'circuit') return sec.completedRounds.length >= sec.rounds;
  if (sec.type === 'exercise') return sec.completedSets.length >= sec.sets;
  if (TIMER_SECTION_TYPES.includes(sec.type)) return sec.completed === true;
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

function pageHeader(root, title) {
  root.appendChild(el('header', { class: 'header' }, [
    el('div', { class: 'title' }, [el('div', { class: 'eyebrow' }, 'Workout'), el('h1', {}, title)]),
  ]));
  root.appendChild(el('nav', { class: 'tab-bar', 'aria-label': 'Main navigation' }, [
    ...[['home', 'Today'], ['goals', 'Goals'], ['progress', 'Progress'], ['history', 'History']].map(([view, label]) =>
      el('button', { class: state.view === view || (view === 'home' && state.view === 'today') ? 'active' : '', 'aria-current': state.view === view ? 'page' : null, on: { click: () => go(view) } }, label)),
  ]));
}

let fieldId = 0;
function field(parent, label, attrs, value, multiline = false) {
  const id = `field-${++fieldId}`;
  const input = el(multiline ? 'textarea' : 'input', { id, ...attrs });
  input.value = value ?? '';
  parent.appendChild(el('div', { class: 'field' }, [el('label', { for: id }, label), input]));
  return input;
}

function disclosure(title, subtitle, content, className = '', open = false) {
  return el('details', { class: `disclosure ${className}`, open }, [
    el('summary', {}, [
      el('span', { class: 'disclosure-heading' }, [el('span', { class: 'disclosure-title' }, title), subtitle ? el('span', { class: 'disclosure-subtitle' }, subtitle) : null]),
      el('span', { class: 'disclosure-arrow', 'aria-hidden': 'true' }, '⌄'),
    ]),
    el('div', { class: 'disclosure-body' }, content),
  ]);
}

function sectionTitle(section) {
  return section.type === 'exercise' ? section.exerciseName || section.name : section.name;
}

function sectionPrescription(section) {
  if (section.type === 'exercise') {
    const reps = section.holdSeconds ? `${section.holdSeconds}s hold` : section.reps ? `${section.reps} reps` : 'hold';
    return `${section.sets} sets · ${reps}${section.weight ? ` · ${section.weight} lb` : ''}`;
  }
  if (section.type === 'circuit') return `${section.rounds} rounds · ${section.exercises.length} exercises`;
  return [section.duration_minutes ? `${section.duration_minutes} min` : '', section.distance_miles ? `${section.distance_miles} mi` : ''].filter(Boolean).join(' · ') || 'Timed';
}

function sectionDetails(section) {
  const children = [];
  const definition = findExercise(state.exercises, section.exerciseId, section.exerciseName || section.name);
  const technique = section.exerciseInstructions || section.instructions || definition?.instructions;
  if (technique) children.push(el('p', {}, technique));
  const video = videoLink(section.youtubeUrl || definition?.youtubeUrl);
  if (video) children.push(video);
  if (section.type === 'exercise') children.push(el('p', { class: 'prescription' }, sectionSummary(section)));

  if (section.type === 'circuit') {
    if (section.interval_seconds) children.push(el('p', {}, `Round target: ${fmtDuration(section.interval_seconds * 1000)}`));
    section.exercises.forEach(ex => children.push(exerciseInstructions(ex)));
  }
  if (section.target_intensity) children.push(el('p', {}, section.target_intensity));
  if (section.why) children.push(el('div', { class: 'detail-group' }, [el('h3', {}, 'Why this exercise'), el('p', {}, section.why)]));
  if (!children.length) children.push(el('p', {}, sectionSummary(section)));
  return children;
}

function workoutDetails(day, rationale, goals = []) {
  return [
    day.summary ? el('p', {}, day.summary) : null,
    rationale ? el('div', { class: 'detail-group' }, [el('h3', {}, 'Why this workout'), el('p', {}, rationale)]) : null,
    goals.length ? el('p', { class: 'muted' }, `Working toward: ${goals.map(g => g.title).join(' · ')}`) : null,
    day.notes ? el('div', { class: 'detail-group' }, [el('h3', {}, 'Session instructions'), el('p', {}, day.notes)]) : null,
  ];
}

async function checkAI() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    state.aiReady = response.ok && (await response.json()).ready === true;
  } catch { state.aiReady = false; }
  if (state.view === 'today' && !state.generating) render();
}

async function generateWorkout(feedback = null) {
  if (state.generating || state.active) return;
  const goals = state.goals.filter(g => g.active).map(({ id, title, details }) => ({ id, title, details }));
  if (!goals.length) return;
  const previous = state.draft;
  const today = { ...state.today };
  state.generating = true; state.revising = !!feedback; state.generationError = ''; state.revisionError = ''; render();
  try {
    const data = await requestAI('workout', buildAIContext({ workflow: 'workout', state, today, feedback }));
    const day = parseDay({ ...data.workout, day: 1 }, 0);
    if (typeof data.rationale !== 'string') throw new Error('The AI returned an incomplete workout. Please try again.');
    const conversation = feedback ? [...(previous.conversation || []), { role: 'user', content: feedback }, { role: 'assistant', content: data.message || 'Updated your workout.' }] : [];
    const draft = { id: uid(), day, rationale: data.rationale, goals, today, conversation, createdAt: now() };
    localStorage.setItem('wt.draft', JSON.stringify(draft));
    state.draft = draft; state.aiReady = true;
    // Keep the usable suggestion even if a phone connection drops during catalog sync.
    const updates = data.catalogUpdates || [];
    state.exercises = data.exerciseCatalog || [...new Map([...state.exercises,...updates].map(exercise=>[exercise.id,exercise])).values()];
    void (async () => {
      try { for (const exercise of updates) await db.saveExercise(exercise); }
      catch { toast('Workout ready. Exercise details will sync when you reload.'); }
    })();
    if (feedback) { state.feedback = ''; localStorage.removeItem('wt.feedback'); }
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'The suggestion took too long. Please try again.' : error.message || 'Could not connect to AI. Please try again.';
    if (feedback) state.revisionError = message; else state.generationError = message;
  } finally { state.generating = false; state.revising = false; render(); }
}

async function sendWorkoutMessage(message) {
  if (state.chatting || state.generating || !state.draft) return;
  const draft = state.draft;
  state.chatting = true; state.revisionError = ''; render();
  try {
    const reply = await requestAI('chat',buildAIContext({workflow:'chat',state,request:message}));
    if (state.draft !== draft) return;
    draft.conversation = [...(draft.conversation || []),{role:'user',content:message},{role:'assistant',content:reply.message}];
    localStorage.setItem('wt.draft',JSON.stringify(draft));
    state.feedback = ''; localStorage.removeItem('wt.feedback');
  } catch(error) {state.revisionError = error.message || 'Could not reach the coach. Please try again.';}
  finally {state.chatting = false; render();}
}

function draftGoalsChanged() {
  return state.draft && JSON.stringify(state.draft.goals) !== JSON.stringify(state.goals.filter(g => g.active).map(({ id, title, details }) => ({ id, title, details })));
}

function startDailyWorkout() {
  if (!state.draft || state.active) return;
  if (draftGoalsChanged()) { state.generationError = 'Your active goals changed. Generate a new suggestion before starting.'; go('today'); return; }
  const d = state.draft;
  state.active = buildActive({ id: 'daily', name: 'Daily workout', days: [d.day] }, 0);
  state.active.source = 'ai';
  state.active.goals = d.goals;
  state.active.rationale = d.rationale;
  state.active.conversation = d.conversation || [];
  state.active.today = d.today;
  saveActive();
  state.draft = null; state.feedback = ''; localStorage.removeItem('wt.draft'); localStorage.removeItem('wt.feedback');
  acquireWakeLock(); go('session');
}

async function reviewCompletedWorkout(id, force = false) {
  if (state.reviewing.has(id)) return;
  state.reviewing.add(id); delete state.reviewErrors[id];
  if (state.view === 'progress') render();
  let revision = null;
  try {
    const workout = await db.getWorkout(id);
    if (!workout || (workout.progressReview && !force)) return;
    revision = workout.resultsRevision || 0;
    const review = await requestAI('progress', buildAIContext({ workflow: 'progress', state, selectedWorkoutId: id }));
    const existing = await db.getWorkout(id);
    if (existing && (existing.resultsRevision || 0) === revision) await db.saveWorkoutIfRevision({ ...existing, progressReviewStatus: 'ready', progressReview: { ...review, createdAt: now() } }, revision);
    state.workouts = await db.listWorkouts();
  } catch (error) {
    const existing = await db.getWorkout(id);
    if (existing && (existing.resultsRevision || 0) === revision) {
      state.reviewErrors[id] = error.name === 'TimeoutError' ? 'AI took too long. Your workout is saved; try the review again.' : error.message;
      if (!await db.saveWorkoutIfRevision({ ...existing, progressReviewStatus: 'error' }, revision)) delete state.reviewErrors[id];
    }
    state.workouts = await db.listWorkouts();
  } finally {
    state.reviewing.delete(id);
    if (state.view === 'progress') render();
    const pending = state.workouts.find(w => w.id === id && w.progressReviewStatus === 'pending' && !w.progressReview);
    if (pending && !state.reviewErrors[id]) reviewCompletedWorkout(id);
  }
}

function progressChart(title, description, entries, key, unit) {
  const values = entries.map(e => Math.max(0, Number(e[key]) || 0));
  const max = Math.max(1, ...values);
  const W = 480, H = 160, baseline = 132, plotHeight = 104;
  const step = 440 / Math.max(1, entries.length);
  const label = time => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fmt = value => Number(value.toFixed(1)).toLocaleString();
  const card = el('div', { class: 'card progress-chart' }, [el('h2', {}, title), el('p', { class: 'muted' }, description)]);
  const chartTitle = String(title).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${chartTitle}"><title>${chartTitle}</title>`;
  for (let i = 0; i <= 2; i++) {
    const y = baseline - i * plotHeight / 2;
    svg += `<line x1="34" x2="478" y1="${y}" y2="${y}" stroke="var(--border)"/><text x="28" y="${y + 3}" text-anchor="end" fill="var(--text-dim)" font-size="10">${fmt(max * i / 2)}</text>`;
  }
  entries.forEach((entry, i) => {
    const x = 38 + i * step, h = values[i] / max * plotHeight;
    svg += `<rect x="${x}" y="${baseline - h}" width="${Math.max(4, step - 10)}" height="${h}" rx="3" fill="${i === entries.length - 1 ? 'var(--accent)' : 'var(--accent-dim)'}"><title>${label(entry.when)}: ${fmt(values[i])} ${unit}</title></rect>`;
    if (entries.length <= 8 || i % 2 === 0 || i === entries.length - 1) svg += `<text x="${x + (step - 10) / 2}" y="151" text-anchor="middle" fill="var(--text-dim)" font-size="9">${label(entry.when)}</text>`;
  });
  svg += '</svg>';
  card.appendChild(el('div', { html: svg }));
  const table = el('table', { class: 'progress-values' }, [el('thead', {}, [el('tr', {}, [el('th', { scope: 'col' }, 'Date'), el('th', { scope: 'col' }, unit)])]), el('tbody', {}, entries.map((entry, i) => el('tr', {}, [el('td', {}, label(entry.when)), el('td', {}, fmt(values[i]))])))]);
  card.appendChild(disclosure('View values', '', [table]));
  return card;
}

async function correctWorkoutResult(id, request) {
  if (state.correcting.has(id)) return;
  state.correcting.add(id); delete state.correctionErrors[id];
  state.expandedWorkoutId = id; render();
  try {
    const current = await db.getWorkout(id);
    if (!current) throw new Error('This session no longer exists.');
    const conversation = current.correctionConversation || [];
    const freshState = { ...state, workouts: state.workouts.map(w => w.id === id ? current : w) };
    const data = await requestAI('correction', buildAIContext({ workflow: 'correction', state: freshState, selectedWorkoutId: id, request }));
    const existing = await db.getWorkout(id);
    if (!existing || (existing.resultsRevision || 0) !== (current.resultsRevision || 0)) throw new Error('This result changed while AI was reviewing it. Please try again.');
    const messages = [...conversation, { role: 'user', content: request }, { role: 'assistant', content: data.message }];
    if (data.status === 'clarify') {
      if (!await db.saveWorkoutIfRevision({ ...existing, correctionConversation: messages, resultsRevision: (existing.resultsRevision || 0) + 1 }, existing.resultsRevision || 0)) throw new Error('The session changed. Please try again.');
    } else {
      if (data.status !== 'apply' || data.workout?.id !== id) throw new Error('The correction was invalid. Your results are unchanged.');
      const { resultUndo: oldUndo, ...before } = existing;
      for (const exercise of data.catalogUpdates || []) await db.saveExercise(exercise);
      state.exercises = await db.listExercises();
      const updated = { ...data.workout, resultUndo: before, correctionConversation: messages, resultsRevision: (existing.resultsRevision || 0) + 1, resultsUpdatedAt: now(), progressReviewStatus: 'pending' };
      delete updated.progressReview;
      if (!await db.saveWorkoutIfRevision(updated, existing.resultsRevision || 0)) throw new Error('The results changed while applying this correction. Please try again.');
    }
    state.correctionMessages[id] = data.message;
    delete state.correctionInputs[id]; localStorage.setItem('wt.correctionInputs', JSON.stringify(state.correctionInputs));
    state.workouts = await db.listWorkouts();
    if (data.status === 'apply') reviewCompletedWorkout(id);
  } catch (error) {
    state.correctionErrors[id] = error.name === 'TimeoutError' ? 'The edit took too long. Your original results are unchanged; please try again.' : error.message;
  } finally { state.correcting.delete(id); if (state.view === 'history') render(); }
}

async function undoResultCorrection(id) {
  const existing = await db.getWorkout(id);
  if (!existing?.resultUndo || state.correcting.has(id)) return;
  const restored = { ...existing.resultUndo, resultsRevision: (existing.resultsRevision || 0) + 1, resultsUpdatedAt: now(), progressReviewStatus: 'pending' };
  delete restored.progressReview;
  if (!await db.saveWorkoutIfRevision(restored, existing.resultsRevision || 0)) { toast('The results changed. Please reopen this session and try again.'); return; }
  state.workouts = await db.listWorkouts(); state.expandedWorkoutId = id;
  state.correctionMessages[id] = 'Restored the results from before your last edit.';
  render(); reviewCompletedWorkout(id);
}

function renderResultCorrection(root, workout) {
  const form = el('form', { class: 'card result-correction', 'aria-label': 'Correct session results' });
  form.appendChild(el('h3', {}, 'Correct these results'));
  const conversation = workout.correctionConversation || [];
  if (conversation.length) {
    form.appendChild(el('p', { class: 'muted', role: 'status' }, state.correctionMessages[workout.id] || conversation.at(-1).content));
    form.appendChild(disclosure('Earlier corrections', '', conversation.slice(0, -1).map(m => el('p', {}, `${m.role === 'user' ? 'You' : 'Coach'}: ${m.content}`))));
  } else if (state.correctionMessages[workout.id]) form.appendChild(el('p', { role: 'status' }, state.correctionMessages[workout.id]));
  const input = field(form, 'What should change about this result?', { placeholder: 'e.g. I wore a 20 lb vest, skipped the last exercise, or took a 15-minute break…', maxlength: 4000, required: true }, state.correctionInputs[workout.id] || '', true);
  input.disabled = state.correcting.has(workout.id);
  input.addEventListener('input', () => { state.correctionInputs[workout.id] = input.value; localStorage.setItem('wt.correctionInputs', JSON.stringify(state.correctionInputs)); });
  if (state.correctionErrors[workout.id]) form.appendChild(el('p', { class: 'error', role: 'alert' }, state.correctionErrors[workout.id]));
  form.appendChild(el('button', { type: 'submit', class: 'primary', disabled: state.correcting.has(workout.id) }, state.correcting.has(workout.id) ? 'Updating results…' : 'Update results'));
  if (workout.resultUndo) form.appendChild(el('button', { type: 'button', class: 'ghost', disabled: state.correcting.has(workout.id), on: { click: () => undoResultCorrection(workout.id) } }, 'Undo last result edit'));
  form.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) correctWorkoutResult(workout.id, input.value.trim()); });
  root.appendChild(form);
}

function renderWorkoutRecord(root, w) {
  const dur = w.endedAt ? workoutDuration(w) : null;
  if (Number.isFinite(w.correctedDurationMs)) root.appendChild(el('p', { class: 'muted' }, `Corrected active time: ${fmtDuration(w.correctedDurationMs)} · original timer: ${fmtDuration(w.endedAt - w.startedAt)}. Round splits retain their recorded times.`));
  if (w.vestWeight != null) root.appendChild(el('p', { class: 'muted' }, `Vest: ${w.vestWeight} lb`));
    if (w.day.notes || w.rationale) root.appendChild(disclosure('About this workout', w.day.summary || '', workoutDetails(w.day, w.rationale, w.goals), 'card'));

    // Last-time comparison banner
    const prior = findPreviousSession(w);
    if (prior) {
      const priorDur = workoutDuration(prior);
      const delta = (dur || 0) - priorDur;
      const daysAgo = Math.round((w.startedAt - prior.startedAt) / 86400000);
      const agoText = daysAgo < 1 ? 'earlier today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;
      const deltaText = Math.abs(delta) < 1000
        ? '(same time)'
        : `(${delta > 0 ? '+' : '−'}${fmtDuration(Math.abs(delta))} ${delta > 0 ? 'longer' : 'shorter'})`;
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'muted' }, `Last time: ${agoText} · ${fmtDuration(priorDur)} ${deltaText}`),
      ]));
    }

    if (w.notes && w.notes.trim()) {
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'muted', style: 'font-style: italic;' }, `"${w.notes.trim()}"`),
      ]));
    }

    if (w.day.type === 'rest') {
      root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'muted' }, 'Rest day — marked complete.')]));
      return;
    }

    (w.sections || []).forEach((sec, secIdx) => {
      const card = el('div', { class: 'card' });
      card.appendChild(disclosure(sectionTitle(sec), sectionPrescription(sec), sectionDetails(sec)));
      if (sec.skipped) card.appendChild(el('div', { class: 'muted' }, 'Skipped'));

      if (sec.type === 'circuit') {
        const stats = circuitStats(sec);
        const avg = stats?.avg ?? 0;
        const fastest = stats?.fastest ?? 0;
        const slowest = stats?.slowest ?? 0;
        card.appendChild(el('div', { class: 'muted' },
          `${sec.completedRounds.length} / ${sec.rounds} rounds · avg ${fmtDuration(avg)} · fastest ${fmtDuration(fastest)} · slowest ${fmtDuration(slowest)}`,
        ));
        // Per-section comparison vs last time
        const priorSec = prior?.sections?.[secIdx];
        if (priorSec && priorSec.type === 'circuit' && !Number.isFinite(w.correctedDurationMs)) {
          const ps = circuitStats(priorSec);
          if (ps && Math.abs(avg - ps.avg) >= 1000) {
            const avgDelta = avg - ps.avg;
            const sign = avgDelta > 0 ? '+' : '−';
            const word = avgDelta > 0 ? 'longer' : 'shorter';
            card.appendChild(el('div', { class: 'muted' },
              `vs last: avg ${fmtDuration(ps.avg)} (${sign}${fmtDuration(Math.abs(avgDelta))} ${word})`,
            ));
          } else if (ps) {
            card.appendChild(el('div', { class: 'muted' }, `vs last: avg ${fmtDuration(ps.avg)} (same)`));
          }
        }

        // Per-round splits
        const rounds = el('div', { class: 'col' });
        sec.completedRounds.forEach((r, i) => {
          const dur = r.endedAt - r.startedAt;
          const repsStr = (r.partial ? 'Partial · ' : '') + r.exercises.map(e => `${e.name}: ${e.skipped ? 'Skipped' : resultDescription(e)}`).join(', ');
          rounds.appendChild(el('div', { class: 'set-row done' }, [
            el('div', { class: 'label' }, `${i + 1}`),
            el('div', { class: 'mono', style: 'text-align:left; grid-column: span 2;' }, repsStr),
            el('div', { class: 'pill' }, fmtDuration(dur)),
          ]));
        });
        card.appendChild(rounds);

        // Totals
        const totalsByEx = {};
        for (const r of sec.completedRounds) {
          for (const ex of r.exercises) {
            if (ex.reps == null) continue;
            totalsByEx[ex.name] = (totalsByEx[ex.name] || 0) + (ex.reps || 0);
          }
        }
        if (Object.keys(totalsByEx).length) card.appendChild(el('div', { class: 'muted', style: 'margin-top: 6px;' }, 'Recorded reps'));
        const totals = el('div', { class: 'col' });
        for (const [name, reps] of Object.entries(totalsByEx)) {
          totals.appendChild(el('div', { class: 'set-row done' }, [
            el('div', { class: 'label' }, '∑'),
            el('div', { class: 'mono', style: 'text-align:left; grid-column: span 2;' }, name),
            el('div', { class: 'pill' }, `${reps} reps`),
          ]));
        }
        card.appendChild(totals);
      } else if (sec.type === 'exercise') {
        const list = el('div', { class: 'col' });
        sec.completedSets.forEach((s, si) => {
          list.appendChild(el('div', { class: 'set-row done' }, [
            el('div', { class: 'label' }, `${si + 1}`),
            el('div', { class: 'mono' }, resultDescription(s)),
            el('div', { class: 'mono' }, s.weight != null ? `${s.weight} lb` : ''),
            el('div', { class: 'pill' }, s.endedAt && s.startedAt ? fmtDuration(s.endedAt - s.startedAt) : '–'),
          ]));
        });
        card.appendChild(list);
      } else if (TIMER_SECTION_TYPES.includes(sec.type)) {
        const dm = sec.timerEndedAt && sec.timerStartedAt ? sec.timerEndedAt - sec.timerStartedAt : null;
        if (sec.trackingValues && Object.keys(sec.trackingValues).length) card.appendChild(el('p', {}, resultDescription(sec)));
        const showLoggedMins = sec.actualMinutes != null && sec.actualMinutes > 0;
        const showLoggedMiles = sec.actualMiles != null && sec.actualMiles > 0;
        card.appendChild(el('div', { class: 'col' }, [
          el('div', { class: 'muted' }, `Elapsed: ${fmtDuration(dm)}`),
          showLoggedMins ? el('div', { class: 'muted' }, `Logged: ${sec.actualMinutes} min`) : null,
          showLoggedMiles ? el('div', { class: 'muted' }, `Distance: ${sec.actualMiles} mi`) : null,
        ]));
      }
      root.appendChild(card);
    });
}

const views = {
  home(root) {
    pageHeader(root, 'Today');
    const activeGoals = state.goals.filter(g => g.active);
    root.appendChild(el('div', { class: 'card hero' }, [
      el('div', { class: 'eyebrow' }, 'Your next step'),
      el('h2', {}, 'A workout that meets you here.'),
      el('p', {}, `${activeGoals.length} active goal${activeGoals.length === 1 ? '' : 's'} · ${state.workouts.length} sessions to learn from`),
      state.active
        ? el('button', { class: 'primary', on: { click: () => go('session') } }, 'Resume workout')
        : el('button', { class: 'primary', on: { click: () => go('today') } }, "I'm working out today"),
      !activeGoals.length ? el('button', { class: 'ghost', on: { click: () => go('goals') } }, 'Add your first goal') : null,
    ]));
    if (state.draft && !state.active) root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'muted' }, `Suggested ${fmtDate(state.draft.createdAt)}`),
      el('h2', {}, state.draft.day.name),
      el('button', { class: 'ghost', on: { click: () => go('today') } }, 'Review suggestion'),
    ]));
    root.appendChild(el('div', { class: 'spread' }, [el('h2', {}, 'Active goals'), el('button', { class: 'ghost', on: { click: () => go('goals') } }, 'Manage goals')]));
    if (!activeGoals.length) root.appendChild(el('p', {}, 'What would you like to work toward? Add any number of goals, and change them whenever you need.'));
    activeGoals.forEach(g => root.appendChild(el('div', { class: 'card' }, [el('h3', {}, g.title), g.details ? el('p', {}, g.details) : null])));
    if (state.workouts[0]) root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'eyebrow' }, 'Last session'),
      el('h3', {}, state.workouts[0].day.name),
      el('p', {}, fmtDate(state.workouts[0].startedAt)),
      el('button', { class: 'ghost', on: { click: () => go('history', { expandedWorkoutId: state.workouts[0].id }) } }, 'View session'),
    ]));
  },

  goals(root) {
    pageHeader(root, 'Goals');
    root.appendChild(el('p', {}, 'Choose what matters to you. Only active goals shape new workout suggestions.'));
    const editing = state.goals.find(g => g.id === state.goalEditing);
    const form = el('form', { class: 'card' });
    form.appendChild(el('h2', {}, editing ? 'Edit goal' : 'Add a goal'));
    const title = field(form, 'Goal', { placeholder: 'e.g. Build up to 10 strict pull-ups', required: true, maxlength: 200 }, editing?.title || '');
    const details = field(form, 'Details (optional)', { placeholder: 'Your starting point, target, or timing', maxlength: 2000 }, editing?.details || '', true);
    if (state.goalError) form.appendChild(el('div', { class: 'error', role: 'alert' }, state.goalError));
    form.appendChild(el('button', { type: 'submit', class: 'primary' }, editing ? 'Save goal' : 'Add goal'));
    if (editing) form.appendChild(el('button', { type: 'button', class: 'ghost', on: { click: () => { state.goalEditing = null; state.goalError = ''; render(); } } }, 'Cancel edit'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      try {
        await db.saveGoal({ ...(editing || { id: uid(), createdAt: now(), active: true }), title: title.value.trim(), details: details.value.trim(), updatedAt: now() });
        state.goals = await db.listGoals();
        state.goalEditing = null; state.goalError = ''; render();
      } catch { state.goalError = 'Could not save your goal. Please try again.'; render(); }
    });
    root.appendChild(form);
    for (const active of [true, false]) {
      const goals = state.goals.filter(g => !!g.active === active);
      if (!goals.length) continue;
      root.appendChild(el('h2', {}, active ? 'Active' : 'Deactivated'));
      goals.forEach(g => root.appendChild(el('div', { class: 'card' + (!active ? ' inactive-goal' : '') }, [
        el('h3', {}, g.title), g.details ? el('p', {}, g.details) : null,
        el('div', { class: 'row' }, [
          el('button', { class: 'ghost', on: { click: () => { state.goalEditing = g.id; state.goalError = ''; render(); } } }, 'Edit'),
          el('button', { class: 'ghost', 'aria-label': `${active ? 'Deactivate' : 'Reactivate'} ${g.title}`, on: { click: async () => {
            try { await db.saveGoal({ ...g, active: !active, updatedAt: now() }); state.goals = await db.listGoals(); render(); }
            catch { toast('Could not update goal. Please try again.'); }
          } } }, active ? 'Deactivate' : 'Reactivate'),
        ]),
      ])));
    }
  },

  today(root) {
    pageHeader(root, "Today's workout");
    if (state.active) {
      root.appendChild(el('div', { class: 'card' }, [el('p', {}, 'You have a workout in progress.'), el('button', { class: 'primary', on: { click: () => go('session') } }, 'Resume workout')]));
      return;
    }
    const activeGoals = state.goals.filter(g => g.active);
    const form = el('form', { class: 'card' });
    form.appendChild(el('h2', {}, 'What works for you today?'));
    const minutes = field(form, 'Time available (minutes)', { type: 'number', min: 5, max: 180, required: true }, state.today.minutes);
    const equipment = field(form, 'Available equipment', { placeholder: 'e.g. Pull-up bar, 20 lb vest, or bodyweight only', maxlength: 2000 }, state.today.equipment);
    const limitations = field(form, 'Limitations or movements to avoid', { placeholder: 'Anything the workout should account for', maxlength: 2000 }, state.today.limitations, true);
    const feeling = field(form, 'How are you feeling? (optional)', { placeholder: 'Energy, soreness, or anything different today', maxlength: 2000 }, state.today.feeling, true);
    for (const [key, input] of Object.entries({ minutes, equipment, limitations, feeling })) input.addEventListener('input', () => {
      state.today[key] = input.value; localStorage.setItem('wt.today', JSON.stringify(state.today));
    });
    form.appendChild(el('p', { class: 'muted' }, `Uses your ${activeGoals.length} active goals, today's details, and all ${state.workouts.length} saved sessions with OpenAI to suggest one workout.`));
    if (!activeGoals.length) form.appendChild(el('button', { type: 'button', class: 'ghost', on: { click: () => go('goals') } }, 'Add an active goal first'));
    if (state.aiReady === false) form.appendChild(el('div', { class: 'notice' }, 'AI is not connected yet. The app server needs an OpenAI API key before it can suggest a workout. Your goals and history are ready.'));
    if (state.generationError) form.appendChild(el('div', { class: 'error', role: 'alert' }, state.generationError));
    form.appendChild(el('button', { type: 'submit', class: 'primary', disabled: state.generating || !activeGoals.length }, state.generating ? 'Creating your workout…' : state.draft ? 'Suggest a different workout' : 'Suggest my workout'));
    if (state.generating && !state.revising) form.appendChild(el('p', { role: 'status' }, 'Reviewing your goals, past sessions, and recovery…'));
    form.addEventListener('submit', e => { e.preventDefault(); generateWorkout(); });
    if (state.draft) {
      form.classList.remove('card');
      root.appendChild(disclosure("Today's setup", `${state.today.minutes} min${state.today.equipment ? ` · ${state.today.equipment}` : ''}`, [form], 'card setup-disclosure', !!state.generationError || (state.generating && !state.revising)));
    } else root.appendChild(form);
    if (state.draft) {
      const d = state.draft;
      root.appendChild(disclosure(d.day.name, `${d.today?.minutes || state.today.minutes} min · ${d.day.sections.length} sections`, workoutDetails(d.day, d.rationale, d.goals), 'card current workout-overview'));
      const sections = el('div', { class: 'workout-list' });
      d.day.sections.forEach(section => sections.appendChild(disclosure(sectionTitle(section), sectionPrescription(section), sectionDetails(section), 'card exercise-disclosure')));
      root.appendChild(sections);
      if (draftGoalsChanged()) root.appendChild(el('p', { class: 'notice' }, 'Your active goals changed. Suggest a new workout to use your current goals.'));
      root.appendChild(el('button', { class: 'primary', disabled: state.generating || state.chatting || draftGoalsChanged(), on: { click: startDailyWorkout } }, 'Start this workout'));
      root.appendChild(el('button', { class: 'ghost', disabled: state.generating || state.chatting, on: { click: () => { state.draft = null; state.feedback = ''; state.revisionError = ''; localStorage.removeItem('wt.draft'); localStorage.removeItem('wt.feedback'); render(); } } }, 'Discard suggestion'));
      const chat = el('form', { class: 'card workout-chat', 'aria-label': 'Chat about workout' });
      chat.appendChild(el('h2', {}, 'Talk to your coach'));
      if (d.conversation?.length) {
        const messageList = items => el('div', { class: 'chat-messages', 'aria-label': 'Workout conversation' }, items.map(message => el('div', { class: `chat-message ${message.role}` }, [el('div', { class: 'eyebrow' }, message.role === 'user' ? 'You' : 'Coach'), el('p', {}, message.content)])));
        if (d.conversation.length > 2) chat.appendChild(disclosure('Earlier conversation', `${Math.max(0,Math.floor(d.conversation.length / 2)-1)} exchanges`, [messageList(d.conversation.slice(0, -2))]));
        chat.appendChild(messageList(d.conversation.slice(-2)));
      }
      const composer = el('div', {class:'chat-composer'});
      const feedbackInput = field(composer, 'Message your coach', { placeholder: 'Ask a question or discuss changes…', maxlength:4000, required:true }, state.feedback, true);
      feedbackInput.disabled = state.revising || state.chatting;
      feedbackInput.addEventListener('input',()=>{state.feedback=feedbackInput.value;localStorage.setItem('wt.feedback',JSON.stringify(state.feedback));});
      composer.appendChild(el('button',{type:'submit',class:'primary chat-send','aria-label':'Send message',disabled:state.generating||state.chatting},state.chatting?'…':'Send ↑'));
      chat.appendChild(composer);
      if (state.revisionError) chat.appendChild(el('div',{class:'error',role:'alert'},state.revisionError));
      if (state.chatting || state.revising) chat.appendChild(el('p',{role:'status'},state.chatting?'Coach is replying…':'Updating your workout…'));
      chat.appendChild(el('p',{class:'muted'},'Chat first. Your workout changes only when you click Update workout.'));
      chat.appendChild(el('button',{type:'button',class:'primary',disabled:state.generating||state.chatting||!d.conversation?.length||!activeGoals.length,on:{click:()=>{
        if (state.feedback.trim()) {state.revisionError='Send your message first so it is included in the conversation.';render();return;}
        generateWorkout('Apply the changes agreed in our conversation to the current workout. Return the full updated workout now; preserve everything else.');
      }}},state.revising?'Updating…':'Update workout'));
      chat.addEventListener('submit',e=>{e.preventDefault();const message=feedbackInput.value.trim();if(message&&!state.generating&&!state.chatting)sendWorkoutMessage(message);});
      root.appendChild(chat);
    }
  },

  session(root) {
    const a = state.active;
    if (!a) { go('home'); return; }

    root.appendChild(el('div', { class: 'header' }, [
      el('div', { class: 'title' }, [
        el('h1', {}, a.day.name),
        el('div', { class: 'muted' }, [
          el('span', {}, 'Elapsed · '),
          el('span', { class: 'timer', id: 'wktimer' }, '0:00'),
        ]),
      ]),
      el('button', { class: 'danger', on: { click: () => cancelSession() } }, 'Cancel'),
    ]));

    if (a.day.type === 'rest') {
      if (a.day.notes || a.rationale) root.appendChild(disclosure('About today', a.day.summary || '', workoutDetails(a.day, a.rationale, a.goals), 'card'));
      root.appendChild(el('div', { class: 'card current' }, [
        el('div', { class: 'exercise-name' }, 'Rest day'),
        el('div', { class: 'muted' }, 'No work today. Mark complete when you\'re done resting (or skip entirely).'),
        el('button', { class: 'primary', disabled: state.finishing, on: { click: () => finishSession() } }, 'Mark rest day complete'),
      ]));
      startWorkoutTimer();
      return;
    }

    if (state.finishError) root.appendChild(el('p', { class: 'error', role: 'alert' }, state.finishError));
    const allDone = a.sections.every(isSectionComplete);
    if (allDone) {
      const notesTa = el('textarea', {
        placeholder: 'Notes (optional): how did it feel? anything notable?',
        style: 'min-height: 80px;',
      });
      notesTa.value = a.notes || '';
      notesTa.addEventListener('input', () => { state.active.notes = notesTa.value; saveActive(); });
      root.appendChild(el('div', { class: 'card current' }, [
        el('div', { class: 'exercise-name' }, '🎉 Session complete'),
        notesTa,
        el('button', { class: 'primary', disabled: state.finishing, on: { click: () => finishSession() } }, 'Finish session'),
      ]));
    }

    if (a.day.notes || a.rationale) root.appendChild(disclosure('About today', a.day.summary || '', workoutDetails(a.day, a.rationale, a.goals), 'card'));

    a.sections.forEach((sec, si) => {
      const isCurrent = si === a.currentSectionIdx;
      const isDone = isSectionComplete(sec);

      const card = el('div', { class: 'card' + (isCurrent && !isDone ? ' current' : '') });
      const info = sectionDetails(sec);
      const chart = el('div', {});
      renderSectionHistoryChart(chart, a.planId, a.dayIndex, si, sec);
      if (chart.childNodes.length) info.push(chart);
      card.appendChild(disclosure(sectionTitle(sec), sectionPrescription(sec), info));

      if (isDone) {
        card.classList.add('done-section');
        card.appendChild(el('div', { class: 'spread' }, [
          el('div', { class: 'muted' }, sec.skipped ? 'Not performed' : sec.endedEarly ? '✓ Ended early · recorded work saved' : '✓ done'),
          el('button', { class: 'ghost', on: { click: () => redoSection(si) } }, '↺ Re-do'),
        ]));
      } else if (isCurrent) {
        if (sec.type === 'circuit') renderCircuit(card, sec, si);
        else if (sec.type === 'exercise') renderExercise(card, sec, si);
        else if (TIMER_SECTION_TYPES.includes(sec.type)) renderCardio(card, sec, si);
        // End early while retaining already recorded work.
        card.appendChild(el('button', { class: 'ghost', on: { click: () => endCurrentSection(si) } }, sec.type === 'circuit' ? 'End this circuit' : 'End exercise'));
      } else {
        card.appendChild(el('div', { class: 'muted' }, 'Up next'));
      }

      root.appendChild(card);
      // Start only after the live timer nodes are in the document.
      if (isCurrent && !isDone) {
        if (sec.restEndsAt != null) startRestTicker(sec, si);
        else if (sec.type === 'exercise' && sec.currentSetStartedAt != null) startSetTicker(si);
        else if (sec.type === 'circuit' && sec.currentRoundStartedAt != null) startRoundTicker(si);
        else if (sec.timerStartedAt != null && sec.timerEndedAt == null) startCardioTicker(si);
      }
    });

    startWorkoutTimer();
    maybeScrollToCurrent(root);
  },

  exercises(root) {
    pageHeader(root, 'Exercise library');
    root.appendChild(el('button', { class: 'ghost', on: { click: () => go('progress') } }, 'Back to progress'));
    root.appendChild(el('p', {}, 'A shared list for workouts and progress. Targets and weights can change while the exercise stays the same.'));
    const form = el('form', { class: 'card' }, [el('h2', {}, 'Add an exercise')]);
    const name = field(form, 'Exercise name', { required: true, maxlength: 300, placeholder: 'e.g. Tuck front lever' }, '');
    const instructions = field(form, 'Technique instructions (setup, movement, key cues)', { required: true, minlength: 40, maxlength: 4000 }, '', true);
    const id = `field-${++fieldId}`;
    const measurement = el('select', { id }, [['reps', 'Reps and load'], ['hold', 'Hold duration'], ['distance', 'Distance and time'], ['time', 'Time']].map(([value, label]) => el('option', { value }, label)));
    form.appendChild(el('div', { class: 'field' }, [el('label', { for: id }, 'Track by'), measurement]));
    if (state.exerciseError) form.appendChild(el('p', { class: 'error', role: 'alert' }, state.exerciseError));
    form.appendChild(el('button', { type: 'submit', class: 'primary' }, 'Create exercise'));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        if (findExercise(state.exercises, null, name.value)) throw new Error('This exercise is already in your library. Use the existing exercise.');
        await db.saveExercise(createExercise({ name: name.value, instructions: instructions.value, measurement: measurement.value }));
        state.exercises = await db.listExercises(); state.exerciseError = ''; render();
      } catch (error) { state.exerciseError = error.message; render(); }
    });
    root.appendChild(disclosure('Create an exercise', '', [form]));
    const history = exerciseProgress(state.workouts, state.exercises);
    for (const exercise of [...state.exercises].sort((a, b) => a.name.localeCompare(b.name))) {
      const recorded = history.find(e => e.exerciseId === exercise.id);
      root.appendChild(disclosure(exercise.name, `${recorded?.entries.length || 0} recorded sessions · ${exercise.measurement}`, [
        el('p', {}, exercise.instructions || 'Technique instructions are supplied with each workout.'),
        videoLink(exercise.youtubeUrl),
        exercise.aliases.length ? el('p', { class: 'muted' }, `Also recorded as: ${exercise.aliases.join(' · ')}`) : null,
        recorded ? el('button', { class: 'ghost', on: { click: () => { state.progressExercise = exercise.id; state.progressLoad = 'all'; go('progress'); } } }, 'View exercise progress') : null,
      ], 'card'));
    }
  },

  progress(root) {
    pageHeader(root, 'Progress');
    root.appendChild(el('button', { class: 'ghost', on: { click: () => go('exercises') } }, 'Exercise library'));
    if (!state.workouts.length) {
      root.appendChild(el('div', { class: 'card' }, [el('h2', {}, 'Your progress starts here'), el('p', {}, 'Finish a workout to get a coach review and start building your charts.')]));
      return;
    }
    const workout = state.workouts.find(w => w.id === state.progressWorkoutId) || state.workouts[0];
    const selectId = `field-${++fieldId}`;
    const select = el('select', { id: selectId }, state.workouts.map(w => el('option', { value: w.id, selected: w.id === workout.id }, `${fmtDate(w.startedAt)} · ${w.day.name}`)));
    select.addEventListener('change', () => { state.progressWorkoutId = select.value; render(); });
    root.appendChild(el('div', { class: 'field' }, [el('label', { for: selectId }, 'Session'), select]));
    const review = workout.progressReview;
    const coach = el('div', { class: 'card current progress-coach' }, [el('div', { class: 'spread' }, [el('div', { class: 'eyebrow' }, "Coach's take"), el('button', { class: 'icon ghost coach-refresh', 'aria-label': "Refresh coach's take", title: "Refresh coach's take", disabled: state.reviewing.has(workout.id), on: { click: () => reviewCompletedWorkout(workout.id, true) } }, '↻')]), el('h2', {}, workout.day.name)]);
    if (review) {
      if (state.reviewing.has(workout.id)) coach.appendChild(el('p', { role: 'status' }, 'Refreshing your progress review…'));
      if (state.reviewErrors[workout.id]) coach.appendChild(el('p', { class: 'error', role: 'alert' }, state.reviewErrors[workout.id]));
      if (state.workouts.some(w => w.resultsUpdatedAt > review.createdAt)) coach.appendChild(el('p', { class: 'muted' }, 'Results have changed since this review. Refresh for an updated take.'));
      coach.appendChild(el('p', { class: 'coach-summary' }, review.summary));
      coach.appendChild(el('ul', { class: 'coach-observations' }, review.observations.map(item => el('li', {}, item))));
      coach.appendChild(el('div', { class: 'detail-group' }, [el('h3', {}, 'Next step'), el('p', {}, review.nextStep)]));
    } else if (state.reviewing.has(workout.id)) {
      coach.appendChild(el('p', { role: 'status' }, 'Reviewing this session alongside your full workout history…'));
    } else {
      if (state.reviewErrors[workout.id] || workout.progressReviewStatus === 'error') coach.appendChild(el('p', { class: 'error', role: 'alert' }, state.reviewErrors[workout.id] || 'The review could not finish. Your workout is saved.'));
      else coach.appendChild(el('p', {}, 'Get a review of this session in the context of your goals and full history. New workouts are reviewed automatically when you finish.'));
      coach.appendChild(el('button', { class: 'primary', on: { click: () => reviewCompletedWorkout(workout.id) } }, workout.progressReviewStatus === 'error' ? 'Retry progress review' : 'Review this session'));
    }
    root.appendChild(coach);
    const latestMetrics = workoutMetrics(workout);
    root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'spread' }, [el('span', {}, 'This session'), el('span', { class: 'mono' }, `${latestMetrics.reps} logged reps · ${fmtDuration(workoutDuration(workout))}`)]), el('button', { class: 'ghost', on: { click: () => go('history', { expandedWorkoutId: workout.id }) } }, 'View or correct results')]));
    const exercises = exerciseProgress(state.workouts, state.exercises);
    if (exercises.length) {
      const ex = exercises.find(e => e.key === state.progressExercise) || exercises[0];
      const controls = el('div', { class: 'card' }, [el('h2', {}, 'Exercise progress')]);
      const exerciseId = `field-${++fieldId}`, metricId = `field-${++fieldId}`, loadId = `field-${++fieldId}`;
      const exerciseSelect = el('select', { id: exerciseId }, exercises.map(item => el('option', { value: item.key, selected: item.key === ex.key }, item.name)));
      exerciseSelect.addEventListener('change', () => { state.progressExercise = exerciseSelect.value; state.progressLoad = 'all'; state.progressMetric = ''; render(); });
      const measures = ex.measurement === 'hold' ? [['holdSeconds', 'Best recorded hold (seconds)'], ['weight', 'Heaviest logged load (lb)']] : ex.measurement === 'distance' ? [['miles', 'Distance (miles)'], ['minutes', 'Recorded minutes']] : ex.measurement === 'time' ? [['minutes', 'Recorded minutes']] : [['bestSetReps', 'Best set (reps)'], ['reps', 'Total logged reps'], ['weight', 'Heaviest logged load (lb)']];
      const metric = measures.some(([key]) => key === state.progressMetric) ? state.progressMetric : measures[0][0];
      const metricSelect = el('select', { id: metricId }, measures.map(([value, name]) => el('option', { value, selected: value === metric }, name)));
      metricSelect.addEventListener('change', () => { state.progressMetric = metricSelect.value; render(); });
      controls.appendChild(el('div', { class: 'field' }, [el('label', { for: exerciseId }, 'Exercise'), exerciseSelect]));
      controls.appendChild(el('div', { class: 'field' }, [el('label', { for: metricId }, 'Measure'), metricSelect]));
      const loads = [...new Set(ex.entries.flatMap(e => e.performances.map(p => p.weight).filter(Number.isFinite)))].sort((a, b) => a - b);
      if (loads.length > 1 && ['reps', 'hold'].includes(ex.measurement)) {
        const loadSelect = el('select', { id: loadId }, [el('option', { value: 'all', selected: state.progressLoad === 'all' }, 'All loads'), ...loads.map(load => el('option', { value: String(load), selected: state.progressLoad === String(load) }, load ? `${load} lb sets` : 'Bodyweight sets'))]);
        loadSelect.addEventListener('change', () => { state.progressLoad = loadSelect.value; render(); });
        controls.appendChild(el('div', { class: 'field' }, [el('label', { for: loadId }, 'Compare at load'), loadSelect]));
      }
      const entries = ex.entries.map(e => exerciseAtLoad(e, state.progressLoad)).filter(Boolean);
      controls.appendChild(el('p', { class: 'muted' }, 'Best sets and holds show performance; total reps show workload. Check load, circuit/sets, and workout position before comparing.'));
      controls.appendChild(el('p', { class: 'muted' }, `${ex.entries.length} recorded sessions · ${fmtDate(ex.entries[0].when)} to ${fmtDate(ex.entries.at(-1).when)}`));
      root.appendChild(controls);
      const measured = entries.filter(e => e[metric] != null);
      if (measured.length) root.appendChild(progressChart(ex.name, `${measures.find(([key]) => key === metric)[1]} · latest 12 sessions`, measured.slice(-12), metric, metric === 'weight' ? 'Pounds' : metric === 'holdSeconds' ? 'Seconds' : metric === 'minutes' ? 'Minutes' : metric === 'miles' ? 'Miles' : 'Reps'));
      else root.appendChild(el('p', { class: 'notice' }, 'No measurements recorded for this selection. Completion is preserved; targets are not treated as measured results.'));
      const history = el('div', { class: 'card' }, [el('h2', {}, `Every time you did ${ex.name}`)]);
      for (const entry of [...entries].reverse()) history.appendChild(disclosure(fmtDate(entry.when), `${entry.sets} completed sets/rounds${entry.reps != null ? ` · ${entry.reps} reps` : ''}${entry.weight ? ` · ${entry.weight} lb` : ''}${entry.holdSeconds != null ? ` · best hold ${entry.holdSeconds}s` : ''}${entry.miles ? ` · ${entry.miles} mi` : ''}`, [
        el('p', {}, entry.workoutName),
        el('p', { class: 'muted' }, `${entry.formats.join(' / ')} · workout block ${entry.positions.join(', ')}`),
        el('p', { class: 'muted' }, ex.measurement === 'hold' && entry.holdSeconds == null ? 'Hold duration was not recorded for this session.' : `${entry.bestSetReps != null ? `Best set: ${entry.bestSetReps} reps` : 'Completion recorded'}${entry.minutes ? ` · ${Number(entry.minutes.toFixed(1))} min` : ''}`),
        el('button', { class: 'ghost', on: { click: () => go('history', { expandedWorkoutId: entry.workoutId }) } }, 'View full session'),
      ]));
      root.appendChild(history);
    }
    const overall = el('div', { class: 'col' });
    const weeks = weeklyProgress(state.workouts);
    overall.appendChild(progressChart('Consistency', 'Training sessions per week · last 8 weeks. Rest days are excluded.', weeks, 'sessions', 'Sessions'));
    overall.appendChild(progressChart('Training volume', 'Actual logged reps per week · last 8 weeks.', weeks, 'reps', 'Reps'));
    overall.appendChild(progressChart('Training time', 'Recorded session minutes per week. Spans over 6 hours are excluded as possible forgotten timers.', weeks, 'minutes', 'Minutes'));
    const excluded = weeks.reduce((sum, w) => sum + w.unusualDurations, 0);
    if (excluded) overall.appendChild(el('p', { class: 'muted' }, `${excluded} unusually long session${excluded === 1 ? '' : 's'} excluded from the time chart. Original history is preserved.`));
    root.appendChild(disclosure('Overall training', 'Weekly consistency, volume and time', [overall], 'card'));

  },

  history(root) {
    pageHeader(root, 'History');
    root.appendChild(el('button', { class: 'ghost', on: { click: downloadHistory } }, 'Download history'));

    if (state.workouts.length === 0) {
      root.appendChild(el('div', { class: 'empty' }, 'No completed sessions yet.'));
      return;
    }

    const stats = computeStats(state.workouts);
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'muted' }, 'This week'),
      el('div', { class: 'stats-row' }, [
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, String(stats.weekSessions)), el('div', { class: 'stat-label' }, 'sessions')]),
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, fmtDuration(stats.weekDuration)), el('div', { class: 'stat-label' }, 'time')]),
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, String(stats.weekReps)), el('div', { class: 'stat-label' }, 'reps')]),
        el('div', { class: 'stat' }, [el('div', { class: 'stat-value' }, String(stats.streak)), el('div', { class: 'stat-label' }, 'day streak')]),
      ]),
    ]));

    if (stats.topExercises.length > 0) {
      const exGrid = el('div', { class: 'ex-grid' });
      for (const [name, reps] of stats.topExercises) {
        exGrid.appendChild(el('div', { class: 'ex-tile' }, [
          el('div', { class: 'stat-value' }, String(reps)),
          el('div', { class: 'stat-label' }, name),
        ]));
      }
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'muted' }, 'Volume by exercise'),
        exGrid,
      ]));
    }

    const list = el('div', { class: 'list' });
    for (const w of state.workouts) {
      const dur = w.endedAt ? workoutDuration(w) : null;
      const record = disclosure(w.day.name, `${fmtDate(w.startedAt)} · ${fmtDuration(dur)} · ${w.day.type}`, [], 'card history-entry', w.id === state.expandedWorkoutId);
      const body = record.querySelector('.disclosure-body');
      const populate = () => {
        if (!record.open || body.childNodes.length) return;
        renderResultCorrection(body, w);
        renderWorkoutRecord(body, w);
        body.appendChild(el('button', { class: 'danger', on: { click: () => deleteHistoryEntry(w) } }, 'Delete session'));
      };
      record.addEventListener('toggle', populate);
      populate();
      list.appendChild(record);
    }
    root.appendChild(list);
  },

};

function computeStats(workouts) {
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const weekSessions = workouts.filter(w => w.startedAt >= weekAgo);
  let weekDuration = 0, weekReps = 0;
  const byExercise = {};
  for (const w of weekSessions) {
    if (w.endedAt) weekDuration += workoutDuration(w);
    for (const sec of (w.sections || [])) {
      if (sec.type === 'circuit') {
        for (const r of (sec.completedRounds || [])) {
          for (const ex of (r.exercises || [])) {
            const reps = ex.reps || 0;
            weekReps += reps;
            byExercise[ex.name] = (byExercise[ex.name] || 0) + reps;
          }
        }
      } else if (sec.type === 'exercise') {
        const name = sec.exerciseName || sec.name;
        for (const s of (sec.completedSets || [])) {
          const reps = s.reps || 0;
          weekReps += reps;
          byExercise[name] = (byExercise[name] || 0) + reps;
        }
      }
    }
  }
  const topExercises = Object.entries(byExercise).filter(([, reps]) => reps > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // Streak: count consecutive days back from today/yesterday with at least one session.
  const daySet = new Set();
  for (const w of workouts) {
    const d = new Date(w.startedAt);
    daySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  let streak = 0;
  for (let i = 0; i < 366; i++) {
    const d = new Date(now - i * 86400000);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (daySet.has(key)) streak++;
    else if (i > 0) break; // allow today to not be done yet without breaking
  }
  return { weekSessions: weekSessions.length, weekDuration, weekReps, streak, topExercises };
}

// ============================================================
// Section history charts
//
// Philosophy: chart the free variable. If the prescription fixes the
// work (rounds/reps/distance), the chart shows time to complete.
// If the prescription fixes the time (duration_minutes), the chart
// shows output (distance; reps/volume when an AMRAP type exists).
// ============================================================

function sectionMetricKind(sec) {
  if (sec.type === 'circuit' || sec.type === 'exercise') return 'time';
  if (TIMER_SECTION_TYPES.includes(sec.type)) {
    if (sec.distance_miles != null && sec.duration_minutes == null) return 'time';
    if (sec.duration_minutes != null) return 'distance';
    return 'time'; // freeform timer
  }
  return null;
}

function sectionMetricValue(sec, kind) {
  if (sec.skipped) return null;
  if (sec.type === 'circuit') {
    if (!sec.completedRounds || sec.completedRounds.length === 0) return null;
    const first = sec.completedRounds[0];
    const last = sec.completedRounds[sec.completedRounds.length - 1];
    return last.endedAt - first.startedAt;
  }
  if (sec.type === 'exercise') {
    if (!sec.completedSets || sec.completedSets.length === 0) return null;
    const first = sec.completedSets[0];
    const last = sec.completedSets[sec.completedSets.length - 1];
    return last.endedAt - first.startedAt;
  }
  if (TIMER_SECTION_TYPES.includes(sec.type)) {
    if (kind === 'distance') {
      return sec.actualMiles != null && sec.actualMiles > 0 ? sec.actualMiles : null;
    }
    if (sec.timerStartedAt != null && sec.timerEndedAt != null) return sec.timerEndedAt - sec.timerStartedAt;
    if (sec.actualMinutes != null && sec.actualMinutes > 0) return sec.actualMinutes * 60000;
    return null;
  }
  return null;
}

function sectionHistory(planId, dayIndex, si, sec) {
  const kind = sectionMetricKind(sec);
  if (!kind) return { kind: null, entries: [] };
  const sessions = state.workouts
    .filter(w => (planId === 'daily' || (w.planId === planId && w.dayIndex === dayIndex)) && w.endedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  const entries = [];
  for (const w of sessions) {
    let s = w.sections?.[si];
    if (!s || s.name !== sec.name || s.type !== sec.type) {
      s = (w.sections || []).find(x => x.name === sec.name && x.type === sec.type);
    }
    if (!s) continue;
    const value = sectionMetricValue(s, kind);
    if (value == null) continue;
    entries.push({ when: w.startedAt, value });
  }
  return { kind, entries: entries.slice(-8) };
}

function fmtMetric(value, kind) {
  if (kind === 'time') return fmtDuration(value);
  if (kind === 'distance') return `${Number(value.toFixed(2))} mi`;
  return String(value);
}

function buildSectionChartSVG(entries, kind) {
  const W = 320, H = 84, padT = 14, padB = 13, gap = 6;
  const n = entries.length;
  const bw = Math.max(10, Math.min(44, (W - gap * (n - 1)) / n));
  const max = Math.max(...entries.map(e => e.value));
  const lowerIsBetter = kind === 'time';
  const best = lowerIsBetter
    ? Math.min(...entries.map(e => e.value))
    : Math.max(...entries.map(e => e.value));
  let out = '';
  const mono = 'ui-monospace,Menlo,monospace';
  entries.forEach((e, i) => {
    const h = Math.max(3, (e.value / max) * (H - padT - padB));
    const x = i * (bw + gap);
    const y = H - padB - h;
    const isLatest = i === n - 1;
    const isBest = e.value === best;
    const fill = isLatest ? 'var(--accent)' : isBest ? 'rgba(74,222,128,0.35)' : 'var(--surface-2)';
    const stroke = isBest ? 'var(--accent)' : 'var(--border)';
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
    if (n <= 6 || isLatest) {
      out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="${isLatest ? 'var(--accent)' : 'var(--text-dim)'}" font-family="${mono}">${fmtMetric(e.value, kind)}</text>`;
    }
  });
  const fd = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  out += `<text x="0" y="${H - 2}" font-size="9" fill="var(--text-dim)" font-family="${mono}">${fd(entries[0].when)}</text>`;
  if (n > 1) {
    const totalW = bw * n + gap * (n - 1);
    out += `<text x="${totalW.toFixed(1)}" y="${H - 2}" text-anchor="end" font-size="9" fill="var(--text-dim)" font-family="${mono}">${fd(entries[n - 1].when)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMid meet" xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}

function renderHistoryChart(card, entries, kind, label) {
  if (entries.length === 0) return;

  const header = [el('div', { class: 'chart-label' }, label)];

  if (entries.length >= 2) {
    const latest = entries[entries.length - 1].value;
    const prev = entries[entries.length - 2].value;
    const delta = latest - prev;
    const lowerIsBetter = kind === 'time';
    const improved = lowerIsBetter ? delta < 0 : delta > 0;
    const same = kind === 'time' ? Math.abs(delta) < 1000 : Math.abs(delta) < 0.01;
    const deltaStr = kind === 'time' ? fmtDuration(Math.abs(delta)) : `${Number(Math.abs(delta).toFixed(2))} mi`;
    const word = kind === 'time' ? (delta < 0 ? 'faster' : 'slower') : (delta > 0 ? 'further' : 'less');
    header.push(el('div', { class: 'chart-trend ' + (same ? '' : improved ? 'good' : 'bad') },
      same ? 'same as last' : `${delta < 0 ? '−' : '+'}${deltaStr} ${word}`));
  }

  card.appendChild(el('div', { class: 'chart' }, [
    el('div', { class: 'spread' }, header),
    el('div', { html: buildSectionChartSVG(entries, kind) }),
  ]));
}

function renderSectionHistoryChart(card, planId, dayIndex, si, sec) {
  const { kind, entries } = sectionHistory(planId, dayIndex, si, sec);
  if (!kind) return;
  renderHistoryChart(card, entries, kind,
    kind === 'time' ? 'Time to complete — history' : 'Distance covered — history');
}

function findPreviousSession(w) {
  return state.workouts
    .filter(x => x.id !== w.id
      && x.planId === w.planId
      && x.dayIndex === w.dayIndex
      && (w.source !== 'ai' || JSON.stringify((w.sections || []).map(s => [s.type, s.name])) === JSON.stringify((x.sections || []).map(s => [s.type, s.name])))
      && x.startedAt < w.startedAt)
    .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

function circuitStats(sec) {
  // A partial round was cut short by End, so its time is not a round split.
  const durs = sec.completedRounds.filter(r => !r.partial).map(r => r.endedAt - r.startedAt);
  if (!durs.length) return null;
  return {
    avg: durs.reduce((a, b) => a + b, 0) / durs.length,
    fastest: Math.min(...durs),
    slowest: Math.max(...durs),
    rounds: durs.length,
    totalReps: sec.completedRounds.reduce((s, r) => s + r.exercises.reduce((a, e) => a + (e.reps || 0), 0), 0),
  };
}

// ============================================================
// Summaries
// ============================================================

function sectionSummary(s) {
  if (s.type === 'circuit') {
    const exs = s.exercises.map(e => `${e.reps} ${e.name}${e.weight ? ` @${e.weight}lb` : ''}`).join(' / ');
    const iv = s.interval_seconds ? ` every ${fmtDuration(s.interval_seconds * 1000)}` : '';
    const rest = s.rest_seconds ? ` · rest ${fmtDuration(s.rest_seconds * 1000)}` : '';
    return `${s.rounds} rounds${iv}${rest}: ${exs}`;
  }
  if (s.type === 'exercise') {
    const ex = s.exerciseName ? `${s.exerciseName} — ` : '';
    return `${ex}${s.sets} × ${s.reps}${s.weight ? ` @${s.weight}lb` : ''}${s.rest_seconds ? ` · rest ${fmtDuration(s.rest_seconds * 1000)}` : ''}`;
  }
  if (TIMER_SECTION_TYPES.includes(s.type)) {
    const parts = [];
    if (s.duration_minutes != null) parts.push(`${s.duration_minutes} min`);
    if (s.distance_miles != null) parts.push(`${s.distance_miles} mi`);
    if (s.target_intensity) parts.push(s.target_intensity);
    if (parts.length === 0) parts.push('freeform timer');
    return parts.join(' · ');
  }
  return '';
}

// ============================================================
// Section renderers (active session)
// ============================================================

function videoLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname)) return null;
    return el('a', {href:url.href, target:'_blank', rel:'noopener noreferrer'}, 'Watch demonstration on YouTube ↗');
  } catch { return null; }
}

function exerciseInstructions(ex) {
  const definition = findExercise(state.exercises, ex.exerciseId, ex.exerciseName || ex.name);
  const instructions = [ex.exerciseInstructions || ex.instructions || definition?.instructions].filter(Boolean);
  const video = videoLink(ex.youtubeUrl || definition?.youtubeUrl);
  const contents = instructions.length ? instructions.map(text => el('p', {}, text)) : [el('p', {}, 'No technique instructions saved for this older exercise.')];
  if (video) contents.push(video);
  return disclosure(ex.exerciseName || ex.name, ex.holdSeconds ? `${ex.holdSeconds}s target` : ex.reps ? `${ex.reps} reps target` : 'Instructions', contents);
}

function resultDescription(result) {
  if (result.partial) return `Partial · ${resultDescription({ ...result, partial: false })}`;
  if (result.trackingValues) {
    const values = Object.values(result.trackingValues).map(field => `${field.label}: ${field.value}${field.unit ? ` ${field.unit}` : ''}`);
    return values.length ? values.join(' · ') : 'Done';
  }
  return result.holdSeconds != null ? `${result.holdSeconds}s hold` : result.reps != null ? `${result.reps} reps${result.weight ? ` · ${result.weight} lb` : ''}` : 'Done';
}

function renderTracking(parent, ex, disabled = false) {
  const tracking = trackingFor(ex);
  const inputs = {};
  for (const field of tracking.fields) {
    const input = el('input', { type: field.type === 'number' ? 'number' : 'text', min: '0', step: 'any', placeholder: 'Optional', 'aria-label': field.label });
    input.disabled = disabled;
    inputs[field.key] = input;
    parent.appendChild(el('label', { class: 'col' }, [el('span', {}, `${field.label}${field.unit ? ` (${field.unit})` : ''}`), input]));
  }
  if (!tracking.fields.length) parent.appendChild(el('p', { class: 'muted' }, 'Completion only · no measurements needed'));
  return () => trackingResult(tracking, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
}

function renderCircuit(card, sec, si) {
  const roundIdx = sec.completedRounds.length; // next round to do (0-indexed)
  const totalRounds = sec.rounds;
  const inRound = sec.currentRoundStartedAt != null;
  const displayRound = inRound ? roundIdx + 1 : Math.min(roundIdx + 1, totalRounds);

  // Splits for completed rounds
  if (sec.completedRounds.length > 0) {
    const splits = el('div', { class: 'splits' });
    sec.completedRounds.forEach((r, i) => {
      splits.appendChild(el('span', { class: 'split-pill' }, [
        el('span', { class: 'split-num' }, `${i + 1}`),
        el('span', { class: 'split-time' }, fmtDuration(r.endedAt - r.startedAt)),
      ]));
    });
    card.appendChild(splits);
  }

  card.appendChild(el('div', { class: 'big-stat' }, [
    el('div', { class: 'big-stat-label' }, 'Round'),
    el('div', { class: 'big-stat-value' }, `${displayRound} / ${totalRounds}`),
  ]));

  if (sec.restEndsAt != null) renderRest(card, sec, si);

  if (inRound) {
    // Live in-round timer (includes budget countdown when interval_seconds is set)
    const liveNode = el('div', { class: 'interval countdown', id: `round-${si}` }, 'In round 0:00');
    card.appendChild(liveNode);
  }

  const exList = el('div', { class: 'col' });
  const readers = [];
  sec.exercises.forEach(ex => {
    const row = el('div', { class: 'card' });
    row.appendChild(exerciseInstructions(ex));
    const read = renderTracking(row, ex, !inRound);
    if (!ex.endedEarly) row.appendChild(el('button', {class:'ghost', on:{click:()=>{
      if (!confirm(`End ${ex.name} for the remaining rounds? Earlier rounds stay saved. Finish the round first to save work from this round.`)) return;
      ex.endedEarly=true; saveActive(); render();
    }}}, 'End exercise'));
    else row.appendChild(el('p', {class:'muted'}, 'Ended · earlier rounds saved'));
    readers.push(() => ({ name: ex.name, exerciseId: ex.exerciseId, ...(ex.endedEarly ? { skipped: true, completed: false } : read()) }));
    exList.appendChild(row);
  });
  card.appendChild(exList);
  if (inRound) partialReaders.set(si, () => readers.map(read => read()));
  if (sec.restEndsAt != null) return;
  card.appendChild(el('button', { class: 'primary', on: { click: () => inRound ? completeCircuitRound(si, readers.map(read => read())) : startCircuitRound(si) } }, inRound ? `Round ${roundIdx + 1} complete` : `Start round ${roundIdx + 1}`));
}

function renderExercise(card, sec, si) {
  const setIdx = sec.completedSets.length;
  const inSet = sec.currentSetStartedAt != null;

  card.appendChild(el('div', { class: 'col' }, [
    // Show completed sets
    ...sec.completedSets.map((s, idx) => el('div', { class: 'set-row done' }, [
      el('div', { class: 'label' }, `${idx + 1}`),
      el('div', { class: 'mono' }, resultDescription(s)),
      el('div', { class: 'mono' }, s.weight != null ? `${s.weight} lb` : ''),
      el('div', { class: 'pill' }, fmtDuration(s.endedAt - s.startedAt)),
    ])),
  ]));

  if (setIdx < sec.sets && sec.restEndsAt != null) renderRest(card, sec, si);
  else if (setIdx < sec.sets) {
    if (inSet) {
      card.appendChild(el('div', {class:'big-stat'}, [
        el('div', {class:'big-stat-label'}, sec.holdSeconds ? `Set ${setIdx+1} · ${sec.holdSeconds}s target` : `Set ${setIdx+1} · elapsed`),
        el('div', {class:'big-stat-value timer',id:`set-${si}`},fmtDuration(now()-sec.currentSetStartedAt)),
      ]));
      const read = renderTracking(card, sec);
      partialReaders.set(si, read);
      card.appendChild(el('button', { class: 'primary', on: { click: () => completeExerciseSet(si, read()) } }, 'Done'));
    } else {
      card.appendChild(el('div', { class: 'set-row' }, [
        el('div', { class: 'label' }, `${setIdx + 1}`),
        el('div', { class: 'mono muted' }, sec.holdSeconds ? `${sec.holdSeconds}s` : `${sec.reps}`),
        el('div', { class: 'mono muted' }, sec.weight ? `${sec.weight} lb target` : ''),
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

  const label = { cardio: 'Cardio', mobility: 'Mobility', warmup: 'Warm-up', cooldown: 'Cool-down' }[sec.type] || 'Timer';
  const valueNode = el('div', { class: 'big-stat-value timer', id: `cardio-${si}` }, '0:00');
  card.appendChild(el('div', { class: 'big-stat' }, [
    el('div', { class: 'big-stat-label' }, label),
    valueNode,
  ]));

  if (inProgress) {
    card.appendChild(el('button', { class: 'primary', on: { click: () => stopCardio(si) } }, 'Stop'));
  } else if (done) {
    const elapsedMs = sec.timerEndedAt - sec.timerStartedAt;
    valueNode.textContent = fmtDuration(elapsedMs);

    const read = renderTracking(card, sec);
    card.appendChild(el('button', { class: 'primary', on: { click: () => finishCardio(si, read()) } }, 'Done & continue'));
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
    if (state.active.startedAt == null) {
      node.textContent = '0:00';
      return;
    }
    node.textContent = fmtDuration(now() - state.active.startedAt);
  };
  update();
  workoutTicker = setInterval(update, 1000);
}

// ============================================================
// Audio (interval rollover beep)
// ============================================================
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playBeep(freq = 880, durationMs = 250) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000);
  } catch {}
}
function buzz(ms = 200) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }

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

const roundTickers = new Map();
const roundLastBudgetState = new Map();
function startRoundTicker(si) {
  stopRoundTicker(si);
  const sec = state.active.sections[si];
  const update = () => {
    const node = document.getElementById(`round-${si}`);
    if (!node || !sec.currentRoundStartedAt) { stopRoundTicker(si); return; }
    const elapsed = now() - sec.currentRoundStartedAt;
    let text = `In round ${fmtDuration(elapsed)}`;
    if (sec.interval_seconds) {
      const targetEnd = sec.currentRoundStartedAt + sec.interval_seconds * 1000;
      const remaining = targetEnd - now();
      const newState = remaining > 0 ? 'ok' : 'over';
      const prev = roundLastBudgetState.get(si);
      if (prev === 'ok' && newState === 'over') { playBeep(880, 300); buzz(250); }
      roundLastBudgetState.set(si, newState);
      if (remaining > 0) {
        text += ` · ${fmtDuration(remaining)} left of ${fmtDuration(sec.interval_seconds * 1000)}`;
        node.classList.remove('overdue');
        node.classList.add('countdown');
      } else {
        text += ` · over by ${fmtDuration(-remaining)}`;
        node.classList.add('overdue');
        node.classList.remove('countdown');
      }
    }
    node.textContent = text;
  };
  update();
  roundTickers.set(si, setInterval(update, 250));
}
function stopRoundTicker(si) {
  if (roundTickers.has(si)) { clearInterval(roundTickers.get(si)); roundTickers.delete(si); }
  roundLastBudgetState.delete(si);
}

let lastScrolledSectionIdx = -1;
let lastScrolledSessionId = null;
function maybeScrollToCurrent(root) {
  const a = state.active;
  if (!a) { lastScrolledSectionIdx = -1; lastScrolledSessionId = null; return; }
  if (a.id !== lastScrolledSessionId) {
    lastScrolledSessionId = a.id;
    lastScrolledSectionIdx = -1;
  }
  if (a.currentSectionIdx === lastScrolledSectionIdx) return;
  lastScrolledSectionIdx = a.currentSectionIdx;
  const node = root.querySelector('.card.current');
  if (node && lastScrolledSectionIdx > 0) {
    requestAnimationFrame(() => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}

// Recompute from the saved start timestamp so a resumed phone stays accurate.
const setTickers = new Map();
function startSetTicker(si) {
  if (setTickers.has(si)) clearInterval(setTickers.get(si));
  const update = () => {
    const sec = state.active?.sections[si];
    const node = document.getElementById(`set-${si}`);
    if (!node || sec?.currentSetStartedAt == null) {
      clearInterval(setTickers.get(si)); setTickers.delete(si); return;
    }
    node.textContent = fmtDuration(Math.max(0,now()-sec.currentSetStartedAt));
  };
  setTickers.set(si,setInterval(update,250));
  update();
}

// Rest countdown is advisory. The next set/round starts only on an explicit tap.
const restTickers = new Map();
function renderRest(card, sec, si) {
  card.appendChild(el('div', { class: 'big-stat' }, [
    el('div', { class: 'big-stat-label' }, 'Rest'),
    el('div', { class: 'big-stat-value timer', id: `rest-${si}` }, fmtDuration(Math.max(0, sec.restEndsAt - now()))),
  ]));
  const startButton = el('button', { class: 'primary', on: { click: () => endRest(si, now()) } }, sec.type === 'circuit' ? 'Start next round' : 'Start next set');
  card.appendChild(startButton);
}
function startRestTicker(sec, si) {
  stopRestTicker(si);
  const update = () => {
    const node = document.getElementById(`rest-${si}`);
    if (!node || sec.restEndsAt == null) { stopRestTicker(si); return; }
    const remaining = sec.restEndsAt - now();
    if (remaining > 0) { node.textContent = fmtDuration(remaining); return; }
    node.textContent = 'Ready';
    stopRestTicker(si);
    if (!sec.restReadyNotified) { sec.restReadyNotified = true; playBeep(880, 300); buzz(250); saveActive(); }
  };
  restTickers.set(si, setInterval(update, 250));
  update();
}
function stopRestTicker(si) {
  if (restTickers.has(si)) { clearInterval(restTickers.get(si)); restTickers.delete(si); }
}
function endRest(si, startAt) {
  stopRestTicker(si);
  const sec = state.active.sections[si];
  if (sec.restEndsAt == null) return;
  sec.restEndsAt = null;
  delete sec.restReadyNotified;
  if (sec.type === 'circuit') sec.currentRoundStartedAt = startAt;
  else sec.currentSetStartedAt = startAt;
  saveActive();
  render();
}
// Reads the in-progress set/round inputs so End can save partial work.
const partialReaders = new Map();

function stopAllTickers() {
  for (const ticker of setTickers.values()) clearInterval(ticker);
  setTickers.clear();
  for (const t of restTickers.values()) clearInterval(t);
  restTickers.clear();
  partialReaders.clear();
  if (workoutTicker) { clearInterval(workoutTicker); workoutTicker = null; }
  for (const t of cardioTickers.values()) clearInterval(t);
  cardioTickers.clear();
  for (const t of roundTickers.values()) clearInterval(t);
  roundTickers.clear();
  roundLastBudgetState.clear();
}

// ============================================================
// Actions
// ============================================================

function startCircuitRound(si) {
  ensureAudioCtx();
  armSession();
  const sec = state.active.sections[si];
  sec.currentRoundStartedAt = now();
  saveActive();
  render();
}

function completeCircuitRound(si, exercisesLog) {
  const sec = state.active.sections[si];
  const started = sec.currentRoundStartedAt || now();
  sec.completedRounds.push({ startedAt: started, endedAt: now(), exercises: exercisesLog });
  // Always auto-start the next round so each round is one tap ('Round complete').
  // Even with an EMOM-style interval, the user can use the on-screen target
  // countdown to pace themselves without a separate Start tap.
  if (sec.completedRounds.length < sec.rounds && sec.rest_seconds) {
    sec.currentRoundStartedAt = null;
    sec.restEndsAt = now() + sec.rest_seconds * 1000;
    delete sec.restReadyNotified;
  } else if (sec.completedRounds.length < sec.rounds) {
    sec.currentRoundStartedAt = now();
  } else {
    sec.currentRoundStartedAt = null;
  }
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function startExerciseSet(si) {
  armSession();
  const sec = state.active.sections[si];
  sec.currentSetStartedAt = now();
  saveActive();
  render();
}

function completeExerciseSet(si, result) {
  const sec = state.active.sections[si];
  const started = sec.currentSetStartedAt || now();
  sec.completedSets.push({
    exerciseId: sec.exerciseId,
    ...result,
    startedAt: started,
    endedAt: now(),
  });
  // Auto-start the next set — one "Done" tap per set, no separate "Start".
  if (sec.completedSets.length < sec.sets && sec.rest_seconds) {
    sec.currentSetStartedAt = null;
    sec.restEndsAt = now() + sec.rest_seconds * 1000;
    delete sec.restReadyNotified;
  } else if (sec.completedSets.length < sec.sets) {
    sec.currentSetStartedAt = now();
  } else {
    sec.currentSetStartedAt = null;
  }
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function startCardio(si) {
  armSession();
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

function finishCardio(si, result) {
  const sec = state.active.sections[si];
  Object.assign(sec, result);
  sec.completed = true;
  saveActive();
  maybeAdvanceSection(si);
  render();
}

function redoSection(si) {
  if (!confirm('Re-do this section? Logged reps/time for it will be cleared.')) return;
  const sec = state.active.sections[si];
  sec.completed = false;
  sec.skipped = false;
  delete sec.endedEarly;
  delete sec.restEndsAt;
  delete sec.trackingValues;
  if (sec.type === 'circuit') {
    sec.completedRounds = [];
    sec.exercises.forEach(ex => {delete ex.endedEarly;});
    sec.currentRoundStartedAt = null;
  } else if (sec.type === 'exercise') {
    sec.completedSets = [];
    sec.currentSetStartedAt = null;
  } else if (TIMER_SECTION_TYPES.includes(sec.type)) {
    sec.timerStartedAt = null;
    sec.timerEndedAt = null;
    sec.actualMinutes = null;
    sec.actualMiles = null;
  }
  state.active.currentSectionIdx = si;
  saveActive();
  render();
}

function endCurrentSection(si) {
  if (!confirm('End here? Completed sets and rounds will be saved, and an unfinished set or round is saved as partial with its time.')) return;
  armSession();
  const sec = state.active.sections[si];
  // Reason: ending mid-set keeps the work done so far, e.g. 25s into a 40s hold (Ben 2026-10-21).
  // Elapsed time is set duration, not a measured hold: it includes getting into position.
  const read = partialReaders.get(si);
  if (sec.type === 'exercise' && sec.currentSetStartedAt != null) sec.completedSets.push({ exerciseId: sec.exerciseId, ...(read ? read() : {}), partial: true, startedAt: sec.currentSetStartedAt, endedAt: now() });
  if (sec.type === 'circuit' && sec.currentRoundStartedAt != null) sec.completedRounds.push({ startedAt: sec.currentRoundStartedAt, endedAt: now(), exercises: read ? read() : [], partial: true });
  delete sec.restEndsAt;
  stopRestTicker(si);
  const hasLoggedWork = (sec.completedSets || []).length > 0 || (sec.completedRounds || []).some(round => round.exercises.some(ex => !ex.skipped));
  if (sec.timerStartedAt != null && sec.timerEndedAt == null) sec.timerEndedAt = now();
  sec.skipped = !hasLoggedWork && !(sec.timerStartedAt != null && sec.timerEndedAt > sec.timerStartedAt);
  sec.endedEarly = !sec.skipped;
  sec.completed = true;
  sec.currentSetStartedAt = null;
  sec.currentRoundStartedAt = null;
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
  if (state.finishing || !state.active) return;
  state.finishing = true; state.finishError = ''; render();
  try {
    const a = state.active;
    if (a.startedAt == null) a.startedAt = now();
    const record = { ...a, endedAt: now(), progressReviewStatus: 'pending' };
    delete record.currentSectionIdx;
    await db.saveWorkout(record);
    state.workouts = await db.listWorkouts();
    state.active = null;
    saveActive(); releaseWakeLock(); stopAllTickers();
    go('progress', { progressWorkoutId: record.id });
    reviewCompletedWorkout(record.id);
  } catch {
    state.finishError = 'Could not save your workout. Your session is still here; please try again.';
  } finally {
    state.finishing = false;
    if (state.view === 'session') render();
  }
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

async function downloadHistory() {
  try {
    const workouts = await db.listWorkouts();
    const data = { exportedAt: new Date().toISOString(), workouts };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workout-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('History downloaded');
  } catch {
    toast('Could not download history. Please try again.');
  }
}

async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    const already = await navigator.storage.persisted();
    if (!already) await navigator.storage.persist();
  } catch {}
}

// ============================================================
// Init
// ============================================================

async function init() {
  await requireAccount();
  requestPersistence(); // best-effort; tells the browser not to evict our data
  state.plans = await db.listPlans();
  state.workouts = await db.listWorkouts();
  state.goals = await db.listGoals();
  checkAI();
  state.active = loadActive();
  const catalog = await db.synchronizeExerciseCatalog({ draft: state.draft, active: state.active });
  state.exercises = catalog.exercises; state.workouts = catalog.workouts.sort((a, b) => b.startedAt - a.startedAt);
  state.draft = catalog.draft; state.active = catalog.active;
  if (state.draft) localStorage.setItem('wt.draft', JSON.stringify(state.draft));
  saveActive();
  if (state.active) {
    state.view = 'session';
    acquireWakeLock();
  }
  const pendingReview = state.workouts.find(w => w.progressReviewStatus === 'pending' && !w.progressReview);
  if (!state.active && pendingReview) { state.view = 'progress'; state.progressWorkoutId = pendingReview.id; }
  render();
  for (const w of state.workouts.filter(w => w.progressReviewStatus === 'pending' && !w.progressReview)) reviewCompletedWorkout(w.id);
}

init().catch(error=>{const root=document.getElementById('app');root.replaceChildren(el('h1',{},'Could not open your workouts'),el('p',{},error.message),el('button',{on:{click:()=>location.reload()}},'Retry'));});
