// Cloudflare Worker — proxies Cloudflare RealtimeKit REST API so credentials
// stay server-side. All env vars are set in wrangler.jsonc.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (url.pathname.startsWith('/api/rtk/')) {
      return handleRTK(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

function rtkBase(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.REALTIMEKIT_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
}

function rtkHeaders(env) {
  return {
    'Authorization': `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
    'Content-Type':  'application/json'
  };
}

async function handleRTK(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!env.REALTIMEKIT_API_TOKEN) {
    return Response.json(
      { error: 'REALTIMEKIT_API_TOKEN is not configured.' },
      { status: 503, headers: corsHeaders() }
    );
  }

  const path = url.pathname.replace('/api/rtk', '');

  try {
    if (request.method === 'GET'  && path === '/debug')  return await debugRTK(env);
    if (request.method === 'POST' && path === '/create') return await createMeeting(request, env);
    if (request.method === 'POST' && path === '/join')   return await joinMeeting(request, env);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}

// Extract a value from either Cloudflare API format (result.x) or Dyte format (data.x)
function pick(json, key) {
  return json?.result?.[key] ?? json?.data?.[key];
}

function assertSuccess(json, label) {
  const ok = json?.success ?? (json?.data !== undefined);
  if (!ok) {
    const msg = json?.errors?.[0]?.message ?? json?.message ?? JSON.stringify(json);
    throw new Error(`${label}: ${msg}`);
  }
}

async function debugRTK(env) {
  const base = rtkBase(env);
  const headers = rtkHeaders(env);

  // Attempt to list meetings (GET) so we get a real response without side effects
  const res = await fetch(`${base}/meetings`, { method: 'GET', headers });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  return Response.json({
    status: res.status,
    base,
    raw: text.slice(0, 2000),
    parsed
  }, { headers: corsHeaders() });
}

async function safeJson(res, label) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  return json;
}

async function createMeeting(request, env) {
  const { title, userName } = await request.json();

  // 1. Create the meeting
  const meetRes  = await fetch(`${rtkBase(env)}/meetings`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({ title })
  });
  const meetJson = await safeJson(meetRes, 'Create meeting');
  assertSuccess(meetJson, 'Create meeting');

  const meetingId = pick(meetJson, 'id');
  if (!meetingId) throw new Error('No meeting ID in response: ' + JSON.stringify(meetJson));

  // 2. Add the host as a participant and receive their auth token
  const partRes  = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            env.REALTIMEKIT_PRESET_NAME,
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partJson = await safeJson(partRes, 'Add participant');
  assertSuccess(partJson, 'Add participant');

  const token = pick(partJson, 'token');
  if (!token) throw new Error('No token in response: ' + JSON.stringify(partJson));

  return Response.json({ meetingId, token }, { headers: corsHeaders() });
}

async function joinMeeting(request, env) {
  const { meetingId, userName } = await request.json();

  const partRes  = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            env.REALTIMEKIT_PRESET_NAME,
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partJson = await safeJson(partRes, 'Join meeting');
  assertSuccess(partJson, 'Join meeting');

  const token = pick(partJson, 'token');
  if (!token) throw new Error('No token in response: ' + JSON.stringify(partJson));

  return Response.json({ token }, { headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
