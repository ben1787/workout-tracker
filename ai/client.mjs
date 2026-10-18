export const DEFAULT_MODEL = 'gpt-6.1-sol';

// One server-only transport for every AI feature. No workflow implements fetch,
// credential handling, model selection, refusal parsing, or timeouts on its own.
export async function structuredResponse(request, { apiKey, fetchImpl = fetch, diagnostics = {}, sourcedUrls } = {}) {
  diagnostics.stage = 'credentials';
  if (!apiKey) throw Object.assign(new Error('AI is not connected yet. Add OPENAI_API_KEY to the app server. Your saved data is unchanged.'), { status: 503 });
  diagnostics.stage = 'provider_request';
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, store: false, instructions: `${request.instructions} Time awareness: timeContext gives the authoritative current date/time and the user timezone. History is sorted oldest first by startedAt. Each workout timing contains ISO/local dates, hours since completion, and calendar-day gaps from the previous workout. Use elapsed hours for recovery and local calendar days for date descriptions. Do not confuse a historical selected workout with today's workout, or treat future/unknown dates as completed recent training. A gap means no recorded sessions, not proof of inactivity. Corrected active duration changes work time, not the real dates or recovery interval. Overlapping sessions and unusually long timer spans are data-quality caveats, not negative recovery or exceptional endurance.` }), signal: AbortSignal.timeout(100000),
    });
  } catch (error) {
    diagnostics.failure = error.name === 'TimeoutError' ? 'timeout' : 'network_error';
    throw Object.assign(new Error(error.name === 'TimeoutError' ? 'AI took too long. Please try again.' : 'Could not reach AI. Please try again.'), { status: 502 });
  }
  diagnostics.providerStatus = response.status;
  diagnostics.providerRequestId = response.headers.get('x-request-id')?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0,150);
  diagnostics.stage = 'provider_response';
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const knownCodes = new Set(['rate_limit_exceeded','insufficient_quota','invalid_api_key','invalid_json_schema','context_length_exceeded','model_not_found','server_error','invalid_request_error']);
    diagnostics.providerErrorCode = knownCodes.has(detail?.error?.code) ? detail.error.code : knownCodes.has(detail?.error?.type) ? detail.error.type : 'other';
    throw Object.assign(new Error(response.status === 401 ? 'The server’s OpenAI API key was rejected.' : response.status === 429 ? 'AI’s request or billing limit was reached. Please try again later.' : 'AI could not complete the request. Your saved data is unchanged.'), { status: 502 });
  }
  const result = await response.json();
  diagnostics.responseStatus = ['completed','incomplete','failed','cancelled','queued','in_progress'].includes(result.status) ? result.status : 'unknown';
  diagnostics.incompleteReason = ['max_output_tokens','content_filter'].includes(result.incomplete_details?.reason) ? result.incomplete_details.reason : undefined;
  for (const item of result.output || []) {
    for (const source of item.action?.sources || []) if (typeof source.url === 'string') sourcedUrls?.add(source.url);
    for (const part of item.content || []) for (const citation of part.annotations || []) if (citation.type === 'url_citation') sourcedUrls?.add(citation.url);
  }
  diagnostics.searchCalls = (result.output || []).filter(item => item.type === 'web_search_call').length;
  const content = (result.output || []).flatMap(item => item.content || []);
  if (content.some(item => item.type === 'refusal')) diagnostics.failure = 'refusal';
  if (result.status !== 'completed' || content.some(item => item.type === 'refusal')) throw Object.assign(new Error('AI could not complete the response. Please try again.'), { status: 502 });
  diagnostics.stage = content.some(item => item.type === 'refusal') ? 'refusal' : 'output_parse';
  try { const output = JSON.parse(content.filter(item => item.type === 'output_text').map(item => item.text).join('')); diagnostics.stage = 'output_validation'; return output; }
  catch { throw Object.assign(new Error('AI returned an incomplete response. Please try again.'), { status: 502 }); }
}

export function invalidResponse(message) { return Object.assign(new Error(message), { status: 502 }); }
