/* Zina AI proxy (Vercel Edge). Checks who is asking, enforces the daily plan limit on the server,
   then streams Claude's answer back as plain text. Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY */
export const config = { runtime: 'edge' };

const LIMIT = { free: 0, pro: 25, elite: 80 };
const MODEL_QUICK = process.env.MODEL_QUICK || 'claude-haiku-4-5-20251001';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-5';
const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

function effectivePlan(e) {   // entitlement written by the owner when a payment is approved
  return e && e.status === 'active' && Number(e.paid_until) > Date.now() ? e.plan : 'free';
}

export default async function handler(req) {
  if (req.method === 'GET') return json({ ok: true, anthropic: !!process.env.ANTHROPIC_API_KEY, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) }, 200);   // health check, no secrets
  if (req.method === 'GET') return json({ anthropic: !!process.env.ANTHROPIC_API_KEY, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), model: MODEL_QUICK }, 200);   // health check for the owner
  if (req.method !== 'POST') return json({ code: 'method' }, 405);
  const SB = process.env.SUPABASE_URL, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY, KEY = process.env.ANTHROPIC_API_KEY;
  if (!SB || !SRK || !KEY) return json({ code: 'not_configured' }, 500);

  const auth = req.headers.get('authorization') || '';
  const ures = await fetch(SB + '/auth/v1/user', { headers: { Authorization: auth, apikey: SRK } });
  if (!ures.ok) return json({ code: 'unauthorized' }, 401);
  const user = await ures.json();

  const H = { apikey: SRK, Authorization: 'Bearer ' + SRK, 'content-type': 'application/json' };
  const [en, ad] = await Promise.all([
    fetch(`${SB}/rest/v1/docs?path=eq.${encodeURIComponent('entitlements/' + user.id)}&select=data`, { headers: H }).then(r => r.json()),
    fetch(`${SB}/rest/v1/admins?user_id=eq.${user.id}&select=user_id`, { headers: H }).then(r => r.json())
  ]);
  const isAdmin = Array.isArray(ad) && ad.length > 0;
  const plan = effectivePlan((en && en[0] && en[0].data) || {});

  let body; try { body = await req.json(); } catch { return json({ code: 'bad_request' }, 400); }
  const kind = body.kind === 'json' ? 'json' : body.kind === 'explain' ? 'explain' : 'chat';
  if (kind === 'json' && !isAdmin) return json({ code: 'forbidden' }, 403);   // question sorting/drafting is owner-only

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-14).map(m => ({ role: m.role, content: m.content.slice(0, kind === 'json' ? 30000 : 8000) }));
  if (!messages.length || messages[0].role !== 'user') return json({ code: 'bad_request' }, 400);
  // page images (owner only: reading scanned exams) ride along with the last user turn
  const imgs = ((kind === 'json' || kind === 'explain') && Array.isArray(body.images) ? body.images : []).slice(0, kind === 'explain' ? 3 : 6)
    .filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === 'string' && i.data.length < 5_500_000);
  if (imgs.length) {
    const last = messages[messages.length - 1];
    last.content = [...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })), { type: 'text', text: last.content }];
  }

  if (!isAdmin) {
    const ok = await fetch(`${SB}/rest/v1/rpc/bump_ai`, { method: 'POST', headers: H, body: JSON.stringify({ p_user: user.id, p_limit: (LIMIT[plan] || 0) + (kind === 'explain' ? 40 : 0) }) }).then(r => r.json());
    if (ok !== true) return json({ code: plan === 'free' && kind !== 'explain' ? 'forbidden' : 'limit' }, plan === 'free' && kind !== 'explain' ? 403 : 429);
  }

  const model = (isAdmin || plan === 'elite' || body.tier === 'default') ? MODEL_SMART : MODEL_QUICK;
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: kind === 'json' ? 8000 : 900, stream: true, messages })
  });
  if (!ar.ok || !ar.body) return json({ code: 'upstream', status: ar.status }, 502);

  const reader = ar.body.getReader(), enc = new TextEncoder(), dec = new TextDecoder(); let buf = '';
  const stream = new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) { ctrl.close(); return; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') ctrl.enqueue(enc.encode(ev.delta.text)); } catch {}
      }
    },
    cancel() { reader.cancel(); }
  });
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
