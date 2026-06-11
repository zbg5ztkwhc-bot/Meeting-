// Cloudflare Worker — proxies Dyte RealtimeKit API requests so credentials
// stay server-side. Requires DYTE_API_KEY set as a Worker secret.
const DYTE_BASE = 'https://api.dyte.io/v2';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (url.pathname.startsWith('/api/dyte/')) {
      return handleDyte(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleDyte(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { DYTE_ORG_ID, DYTE_API_KEY, DYTE_PRESET_ID } = env;

  if (!DYTE_ORG_ID || !DYTE_API_KEY) {
    return Response.json(
      { error: 'DYTE_ORG_ID and DYTE_API_KEY must be configured as Worker secrets.' },
      { status: 503, headers: corsHeaders() }
    );
  }

  const auth      = 'Basic ' + btoa(`${DYTE_ORG_ID}:${DYTE_API_KEY}`);
  const presetId  = DYTE_PRESET_ID;
  const path      = url.pathname.replace('/api/dyte', '');

  try {
    if (request.method === 'POST' && path === '/create') {
      return await createMeeting(request, auth, presetId);
    }
    if (request.method === 'POST' && path === '/join') {
      return await joinMeeting(request, auth, presetId);
    }
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: corsHeaders() });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders() });
}

async function createMeeting(request, auth, presetId) {
  const { title, userName } = await request.json();

  const meetRes = await fetch(`${DYTE_BASE}/meetings`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  const meetData = await meetRes.json();
  if (!meetData.success) throw new Error(meetData.message || 'Failed to create meeting');

  const meetingId = meetData.data.id;

  const partRes = await fetch(`${DYTE_BASE}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: userName,
      preset_id: presetId,
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partData = await partRes.json();
  if (!partData.success) throw new Error(partData.message || 'Failed to add participant');

  return Response.json(
    { meetingId, token: partData.data.token },
    { headers: corsHeaders() }
  );
}

async function joinMeeting(request, auth, presetId) {
  const { meetingId, userName } = await request.json();

  const partRes = await fetch(`${DYTE_BASE}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: userName,
      preset_id: presetId,
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partData = await partRes.json();
  if (!partData.success) throw new Error(partData.message || 'Failed to join meeting');

  return Response.json(
    { token: partData.data.token },
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
