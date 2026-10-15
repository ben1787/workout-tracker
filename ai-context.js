import { chronologicalContext } from './ai-time.js';
import { weeklyProgress, exerciseProgress, workoutMetrics } from './progress.js';

// Shared browser/server contract: operational metadata and undo copies are never
// model evidence. All actual/prescribed workout data and user explanations are.
export function workoutEvidence(workout) {
  if (!workout) return null;
  const { resultUndo, progressReview, progressReviewStatus, correctionConversation, ...evidence } = workout;
  return evidence;
}

export function buildAIContext({ workflow, state, selectedWorkoutId, request, feedback, today = state.today, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  const chronology = chronologicalContext(state.workouts.map(workoutEvidence), { now, timeZone, selectedWorkoutId });
  const history = chronology.history;
  const selected = state.workouts.find(w => w.id === selectedWorkoutId);
  const context = {
    contractVersion: 1, workflow,
    goals: state.goals.filter(g => g.active).map(({ id, title, details }) => ({ id, title, details: details || '' })),
    today: { ...today }, history,
    exerciseCatalog: state.exercises || [],
    currentWorkout: state.draft ? { workout: state.draft.day, rationale: state.draft.rationale } : undefined,
    activeSession: workoutEvidence(state.active),
    selectedWorkoutId: selected?.id,
    previousReview: selected?.progressReview || undefined,
    progress: {
      weekly: weeklyProgress(state.workouts, now),
      selected: selected ? workoutMetrics(selected) : undefined,
      exercises: exerciseProgress(state.workouts, state.exercises || []).map(ex => ({ exerciseId: ex.exerciseId, name: ex.name, measurement: ex.measurement, recent: ex.entries.slice(-12) })),
    },
    date: chronology.date, timeZone: chronology.timeZone, timeContext: chronology.timeContext,
  };
  if (workflow === 'workout') {
    if (feedback) { context.feedback = feedback; context.conversation = state.draft?.conversation || []; }
  } else if (workflow === 'progress') context.completedWorkoutId = selectedWorkoutId;
  else if (workflow === 'correction') { context.workout = workoutEvidence(selected); context.request = request; context.conversation = selected?.correctionConversation || []; }
  else throw new Error('Unknown AI workflow.');
  return context;
}

// Also normalize at the API boundary for callers other than the UI.
export function prepareAIContext(context, { now = new Date() } = {}) {
  const chronology = Array.isArray(context?.history) ? chronologicalContext(context.history.map(workoutEvidence), { now, timeZone: context.timeZone, selectedWorkoutId: context.selectedWorkoutId || context.completedWorkoutId || context.workout?.id }) : null;
  return {
    ...context,
    goals: Array.isArray(context?.goals) ? context.goals.filter(g => g?.active !== false) : context?.goals,
    history: chronology ? chronology.history : context?.history,
    ...(chronology ? { date: chronology.date, timeZone: chronology.timeZone, timeContext: chronology.timeContext } : {}),
    workout: context?.workout ? workoutEvidence(context.workout) : context?.workout,
  };
}
