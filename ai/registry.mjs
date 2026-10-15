import { suggestWorkout, responseRequest } from './workout.mjs';
import { reviewProgress, progressRequest } from './progress.mjs';
import { correctResult, correctionRequest } from './correction.mjs';
import { DEFAULT_MODEL } from './client.mjs';
import { AI_ENDPOINTS } from '../ai-api.js';
import { prepareAIContext } from '../ai-context.js';

// This is the complete AI capability surface. New UI features register here
// rather than adding ad hoc API routes, model calls, or broad write authority.
export const AI_WORKFLOWS = Object.freeze({
  [AI_ENDPOINTS.workout]: { name: 'workout', reads: 'Active goals, today, current suggestion, revision conversation, full corrected history and progress', writes: 'Returns a suggested workout; UI explicitly starts it', validate: responseRequest, run: suggestWorkout },
  [AI_ENDPOINTS.progress]: { name: 'progress', reads: 'Selected completion, active goals, constraints, full corrected history and computed progress', writes: 'Commentary only; never changes a result', validate: progressRequest, run: reviewProgress },
  [AI_ENDPOINTS.correction]: { name: 'correction', reads: 'Selected workout, its previous review and correction conversation, goals, constraints, current suggestion, active session, full corrected history and progress', writes: 'Validated operations on selected saved workout only; UI keeps undo', validate: correctionRequest, run: correctResult },
});

export async function runAIWorkflow(path, rawContext, options = {}) {
  const workflow = AI_WORKFLOWS[path];
  if (!workflow) throw Object.assign(new Error('Unknown AI workflow.'), { status: 404 });
  const context = prepareAIContext(rawContext);
  try {
    if (context.workflow && context.workflow !== workflow.name) throw new Error('AI workflow context does not match this request.');
    workflow.validate(context, options.model || DEFAULT_MODEL);
  } catch (error) { error.status = 400; throw error; }
  return workflow.run(context, options);
}
