export const AI_ENDPOINTS = Object.freeze({ workout: '/api/workout', progress: '/api/progress', correction: '/api/correct-result' });

// The browser has no provider credentials and no direct model calls.
export async function requestAI(workflow, context, {fetchImpl = fetch, pause = () => new Promise(resolve=>setTimeout(resolve,1500))} = {}) {
  const endpoint = AI_ENDPOINTS[workflow];
  if (!endpoint) throw new Error('Unknown AI workflow.');
  const asyncRequest = workflow === 'workout';
  const jobRequestId = crypto.randomUUID();
  const deadline = Date.now()+240000;
  const fetchJSON = async (url, options = {}) => {
    while (true) {
      try {
        const response = await fetchImpl(url,{...options,signal:AbortSignal.timeout(asyncRequest ? 15000 : 120000)});
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw Object.assign(new Error('Could not connect to the workout server.'),{retryable:true});
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || 'AI could not complete the request. Please try again.'),{retryable:response.status === 503});
        return data;
      } catch(error) {
        const interrupted = ['AbortError','TimeoutError','TypeError'].includes(error.name) || error.retryable;
        if (asyncRequest && interrupted && Date.now()<deadline) {await pause(); continue;}
        if (interrupted) throw new Error('The connection was interrupted. Please check your connection and try again.');
        throw error;
      }
    }
  };
  const data = await fetchJSON(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(asyncRequest ? {Prefer:'respond-async','X-AI-Request-ID':jobRequestId} : {})},body:JSON.stringify(context)});
  if (!asyncRequest) return data;
  while (true) {
    const job=await fetchJSON(`/api/ai-jobs/${encodeURIComponent(data.jobId)}`,{cache:'no-store'});
    if (job.state === 'completed') return job.result;
    if (job.state === 'failed') throw new Error(job.error || 'AI could not complete the workout. Please try again.');
    if (Date.now()>deadline) throw new Error('The workout is taking longer than expected. Please try again.');
    await pause();
  }
}
