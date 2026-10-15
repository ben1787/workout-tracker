# Workout Tracker

A local-first daily workout coach. Add any number of goals, deactivate/reactivate
or edit them, and ask for a workout when you decide to train. AI uses active goals,
today's time/equipment/limitations/feeling, and all saved workout history. Review
its suggestion before starting; the existing circuit, set and timer tracker logs
the session. Finishing opens Progress and automatically requests a GPT 6.1 Sol review
of the completion against all saved history and active goals. Reviews are stored
with the session and included in backups; revisiting does not regenerate them.
A failed review can be retried without losing the workout. Progress charts show
weekly training frequency, logged reps, valid session time and exercise reps/load.
Time spans over six hours are excluded from time charts as possible forgotten
timers; original records remain untouched. Prescribed hold durations are not
charted as actual results. Old programs are preserved in backups but no longer appear in the UI.

## Run locally

Requires Node.js 22 or later. No packages to install.

1. Copy `.env.example` to `.env`.
2. Set `OPENAI_API_KEY` in `.env` to your OpenAI API key. API usage is billed by
   your OpenAI API account; a ChatGPT subscription does not configure this key.
3. Run `npm start` and open http://127.0.0.1:8765.

Goals and history work without the key. AI generation needs a network connection
and the Node server. The key remains on the server; only a connection status is
sent to the browser. Suggestions use the OpenAI Responses API with structured
outputs, and `store: false`. Active goals, today's details, and saved workout
records (including notes) are sent to OpenAI only when requesting a suggestion.
No automatic background generation or upload occurs.

Keep using the same address/port to retain browser-local data. A different browser,
hostname or device has separate storage. Backups combine these stores: History →
Import backup adds new goals/sessions and skips IDs already present. It never
replaces existing records. Exports contain goals, completed sessions and legacy
plans; they do not contain an unfinished session or a workout suggestion.

## Hosting

The old GitHub Pages version is static and cannot run the AI endpoint. This
server binds to 127.0.0.1 and enforces local origins. Using AI on your phone will
require an authenticated HTTPS backend and a frontend deployment that points to
it. Do not expose this personal local server publicly or publish the API key.
No deployment is performed by these changes.

## Checks

`npm test` runs deterministic regression coverage. Live generation also needs a
configured API key. An HTTP stub can verify protocol and UI plumbing, but does
not establish real model quality or account access.

API reference: https://developers.openai.com/api/docs/guides/structured-outputs

## AI structure

AI features use bounded structured workflows rather than a general agent with
arbitrary write tools. GPT 6.1 Sol is the default for every workflow.

| Workflow | Context it can read | Allowed change |
| --- | --- | --- |
| Suggest/revise workout | Active goals, today's constraints, current suggestion and conversation, active session, complete corrected history and computed progress | Return a draft workout; it does not edit goals or saved history |
| Review progress | Selected completion, goals, constraints, corrected history and computed progress | Return commentary; no result writes |
| Correct saved workout | All shared context plus the selected workout, previous coach review and correction conversation | Return validated operations on that selected workout and its results only |

`ai-context.js` builds this shared context for the browser. It includes current
workout definitions, actual results, corrected durations and user explanations,
while stripping undo snapshots and cached AI reviews from historical evidence.
The selected coach review is supplied separately for corrections. `ai-api.js`
provides the single browser API path. The server uses `ai/registry.mjs` as its
capability registry, and `ai/client.mjs` owns credentials, the model, timeouts,
structured response parsing and errors. Each workflow's prompt, schema and
validation live together in `ai/workout.mjs`, `ai/progress.mjs`, or
`ai/correction.mjs`.

`corrections.js` applies only explicit supported edits. A vest correction changes
the selected workout's strength exercise definitions and logged loads together;
a set-specific result correction changes only that result. Missing weights or
ambiguous exercise references require clarification. Explanations alone add notes;
only explicit timing corrections change active duration. Original timer/splits
remain available. The browser saves an undo snapshot and invalidates the affected
coach review. Undo restores the previous workout and results. The coach card's
refresh button can request new commentary at any time.

AI does not have permission to edit goals, other sessions, or the active workout
from a historical correction. Add a new workflow to the registry with its context,
schema, validation and mutation boundary when expanding those capabilities.

Every AI request has a fresh server-validated time context: today's date in the
user's timezone, current UTC/local time, and complete history sorted oldest to
newest. Each workout includes readable UTC/local dates, hours since completion,
and gaps from the preceding session. The context distinguishes rest records from
actual training, elapsed hours from local calendar days, and historical selected
workouts from today's session. Future/unknown timestamps and overlapping timers
are flagged rather than interpreted as recent training or negative recovery.
Corrected active durations do not change the original dates or recovery interval.

### Exercise identity and tracking

The IndexedDB exercise catalog gives movements stable IDs, canonical names, aliases and technique instructions. Existing backups and browser history are linked conservatively without changing recorded reps, load or timestamps; technique variants remain distinct. Generation must reuse a catalog entry or explicitly declare a new definition with useful instructions before referencing it. The Progress page includes the library and every recorded occurrence of a selected exercise.

AI chooses `tracking.fields` independently for each prescription. An empty array means completion only. Optional numeric or text fields carry a key, label and unit; standard keys (`reps`, `weight`, `holdSeconds`, `minutes`, `miles`) feed the corresponding measurements. Custom fields retain their labeled values in history and AI context. Inputs start blank. Targets and timer timestamps remain separate from actual measurements; neither a target hold nor elapsed set time becomes a measured hold. Legacy warmups and fixed holds default to completion only.

Exercise comparisons expose set/circuit format and workout position, with exact-load filtering for recorded sets. Best sets/holds describe performance; total reps describe workload. Completion-only entries remain visible without creating measurement points. These comparisons provide evidence for coaching, rather than a universal progress score across different movements and conditions.
