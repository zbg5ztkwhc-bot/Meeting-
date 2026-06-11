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
    if (request.method === 'POST' && path === '/create') return await createMeeting(request, env);
    if (request.method === 'POST' && path === '/join')   return await joinMeeting(request, env);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}

async function createMeeting(request, env) {
  const { title, userName } = await request.json();

  // 1. Create the meeting
  const meetRes = await fetch(`${rtkBase(env)}/meetings`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({ title })
  });
  const meetJson = await meetRes.json();
  if (!meetJson.success) throw new Error(meetJson.errors?.[0]?.message || 'Failed to create meeting');

  const meetingId = meetJson.result.id;

  // 2. Add the host as a participant and receive their auth token
  const partRes = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                   userName,
      preset_id:              env.REALTIMEKIT_PRESET_ID,
      custom_participant_id:  crypto.randomUUID()
    })
  });
  const partJson = await partRes.json();
  if (!partJson.success) throw new Error(partJson.errors?.[0]?.message || 'Failed to add participant');

  return Response.json(
    { meetingId, token: partJson.result.token },
    { headers: corsHeaders() }
  );
}

async function joinMeeting(request, env) {
  const { meetingId, userName } = await request.json();

  const partRes = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                   userName,
      preset_id:              env.REALTIMEKIT_PRESET_ID,
      custom_participant_id:  crypto.randomUUID()
    })
  });
  const partJson = await partRes.json();
  if (!partJson.success) throw new Error(partJson.errors?.[0]?.message || 'Failed to join meeting');

  return Response.json(
    { token: partJson.result.token },
    { headers: corsHeaders() }
  );
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
