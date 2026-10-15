export const DEFAULT_MODEL = 'gpt-6.1-sol';

// One server-only transport for every AI feature. No workflow implements fetch,
// credential handling, model selection, refusal parsing, or timeouts on its own.
export async function structuredResponse(request, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw Object.assign(new Error('AI is not connected yet. Add OPENAI_API_KEY to the app server. Your saved data is unchanged.'), { status: 503 });
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, store: false, instructions: `${request.instructions} Time awareness: timeContext gives the authoritative current date/time and the user timezone. History is sorted oldest first by startedAt. Each workout timing contains ISO/local dates, hours since completion, and calendar-day gaps from the previous workout. Use elapsed hours for recovery and local calendar days for date descriptions. Do not confuse a historical selected workout with today's workout, or treat future/unknown dates as completed recent training. A gap means no recorded sessions, not proof of inactivity. Corrected active duration changes work time, not the real dates or recovery interval. Overlapping sessions and unusually long timer spans are data-quality caveats, not negative recovery or exceptional endurance.` }), signal: AbortSignal.timeout(100000),
    });
  } catch (error) {
    throw Object.assign(new Error(error.name === 'TimeoutError' ? 'AI took too long. Please try again.' : 'Could not reach AI. Please try again.'), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'The server’s OpenAI API key was rejected.' : response.status === 429 ? 'AI’s request or billing limit was reached. Please try again later.' : 'AI could not complete the request. Your saved data is unchanged.'), { status: 502 });
  const result = await response.json();
  const content = (result.output || []).flatMap(item => item.content || []);
  if (result.status !== 'completed' || content.some(item => item.type === 'refusal')) throw Object.assign(new Error('AI could not complete the response. Please try again.'), { status: 502 });
  try { return JSON.parse(content.filter(item => item.type === 'output_text').map(item => item.text).join('')); }
  catch { throw Object.assign(new Error('AI returned an incomplete response. Please try again.'), { status: 502 }); }
}

export function invalidResponse(message) { return Object.assign(new Error(message), { status: 502 }); }
