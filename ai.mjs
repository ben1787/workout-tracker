// Public entrypoints retained for focused tests and non-HTTP callers.
export * from './ai/workout.mjs';
export * from './ai/progress.mjs';
export * from './ai/correction.mjs';
export { AI_WORKFLOWS, runAIWorkflow } from './ai/registry.mjs';
