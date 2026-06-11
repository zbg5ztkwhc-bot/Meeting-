// Cloudflare Worker — proxies Cloudflare Calls API requests so the
// app token is never exposed to the browser.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (url.pathname.startsWith('/api/calls')) {
      return proxyCallsAPI(request, env, url);
    }

    // Serve static assets (index.html, etc.)
    return env.ASSETS.fetch(request);
  }
};

async function proxyCallsAPI(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { CALLS_APP_ID, CALLS_APP_TOKEN } = env;

  if (!CALLS_APP_ID || !CALLS_APP_TOKEN) {
    return Response.json(
      { error: 'CALLS_APP_ID and CALLS_APP_TOKEN must be configured as Worker secrets.' },
      { status: 503, headers: corsHeaders() }
    );
  }

  const cfPath = url.pathname.slice('/api/calls'.length);
  const cfURL  = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}${cfPath}`;

  const upstream = await fetch(cfURL, {
    method:  request.method,
    headers: {
      'Authorization': `Bearer ${CALLS_APP_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
  });

  const body = await upstream.text();
  return new Response(body, {
    status:  upstream.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
