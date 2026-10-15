export const AI_ENDPOINTS = Object.freeze({ workout: '/api/workout', progress: '/api/progress', correction: '/api/correct-result' });

// The browser has no provider credentials and no direct model calls.
export async function requestAI(workflow, context) {
  const endpoint = AI_ENDPOINTS[workflow];
  if (!endpoint) throw new Error('Unknown AI workflow.');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(120000) });
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('Start the app server to connect AI. Your saved data is unchanged.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'AI could not complete the request. Please try again.');
  return data;
}
