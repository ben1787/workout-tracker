# Workout Tracker

A local-first daily workout coach. Add any number of goals, deactivate/reactivate
or edit them, and ask for a workout when you decide to train. AI uses active goals,
today's time/equipment/limitations/feeling, and all saved workout history. Review
its suggestion before starting; the existing circuit, set and timer tracker logs
the session. Finishing opens Progress and automatically requests a GPT 6.1 Sol review
of the completion against all saved history and active goals. Reviews are stored
with the session and included in history downloads; revisiting does not regenerate them.
A failed review can be retried without losing the workout. Progress charts show
weekly training frequency, logged reps, valid session time and exercise reps/load.
Time spans over six hours are excluded from time charts as possible forgotten
timers; original records remain untouched. Prescribed hold durations are not
charted as actual results. Old programs remain in storage but no longer appear in the UI.

## Run locally

Requires Node.js 22 or later. Run `npm ci` first.

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

For local development, keep using the same address/port to retain browser-local
records. The hosted app loads completed history from your account on every device.
History → Download history downloads all saved sessions as JSON, including their
exercise results, timestamps, notes and coaching, for reading elsewhere or
uploading to ChatGPT. There are no import controls or backup reminders in the UI.

## Hosted account on Render

`render.yaml` defines a Node web service in the separate Workout App project
in Ben's Render workspace. Its database is a dedicated **free Supabase project**
in the separate **Ben's Workout App** organization. Neither deployment depends
on any Porter project, database, environment group or application credentials.
Render compute sleeps when idle; Supabase's free project can pause after a week
of inactivity. The Supabase database has no fixed 30-day trial expiration.

The backend connects through Supabase's session pooler on port 5432 using a
dedicated `workout_app` role. Its tables live in the private `workout` schema,
which is not exposed through the Supabase Data API. Anonymous and authenticated
API roles have no schema access. App tables also enable RLS; the backend-owned
role uses the existing account-scoped SQL authorization.

`DATABASE_SSL=true` enables verified TLS. `DATABASE_SSL_CA` holds the public
Supabase root CA PEM (available in the project's SSL settings); verification is
never disabled. Configure these and `DATABASE_URL` privately on the web service.
The original Render database was copied with exact table-content verification
and retained read-only as a rollback snapshot, rather than used by the app.

With `DATABASE_URL` set, goals, exercises, legacy plans and completed workouts
are stored in Postgres, scoped to the authenticated account. Without it the app
continues using its original browser store. In-progress sessions and unstarted
suggestions stay on the device until completion; completed history is shared.

The hosted app requires an account. Owner enrollment requires the private
`SETUP_TOKEN` and is disabled after the first account is created. Passwords use
salted scrypt hashes. Random session tokens are stored as hashes in Postgres;
the browser gets a Secure, HttpOnly, SameSite cookie. Login is rate-limited,
mutations require the app's exact Origin, and all data/AI routes require sign-in.
`PUBLIC_ORIGIN` overrides the expected origin; Render's external URL is used by
default. The OpenAI key stays in the service's private environment.

Use the private setup link to choose an email and a password (12+ characters).
There is no public signup or email password-recovery service in this personal
trial. An operator can reset access through the database if needed.

The initial migration preserved the local copy. A private bootstrap import staged
the owner's existing history before enrollment; registration claims it in the
same transaction and removes the staging copy. The app does not expose an import
flow. No history is publicly served.

Each saved record has a server revision. Edits made from a stale device receive
a conflict instead of overwriting a newer record; refresh before retrying. AI
reviews additionally compare the result revision to avoid replacing corrections.
The account bar's Refresh button loads the latest data from other devices.

GitHub Pages automatic deployments are disabled; Render is the release target.
The existing Pages deployment remains available for exporting old-device data.

## Checks

`npm test` runs deterministic regression coverage. Set `TEST_DATABASE_URL` to an
isolated Postgres database to also run the hosted HTTP/auth/storage regression.
That test uses a temporary schema; CI provisions a disposable Postgres service. Live generation also needs a
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
