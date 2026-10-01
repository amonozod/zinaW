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
  if (body.diag) {                                             // owner-only self test: one short, non-streamed call per model, full error text
    if (!isAdmin) return json({ code: 'forbidden', detail: 'Only admins can run the check (add yourself to the admins table).' }, 403);
    const out = [];
    for (const m of [...new Set([MODEL_QUICK, MODEL_SMART, 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5'])]) {
      const t0 = Date.now();
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY.trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: m, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with just OK.' }] }) });
        const j = await r.json().catch(() => ({}));
        out.push({ model: m, ok: r.ok, status: r.status, ms: Date.now() - t0, text: r.ok ? (j.content && j.content[0] && j.content[0].text) || '' : (j.error && (j.error.message || j.error.type)) || 'HTTP ' + r.status });
        if (r.ok) break;
      } catch (e) { out.push({ model: m, ok: false, status: 0, ms: Date.now() - t0, text: String(e && e.message || e) }); }
    }
    return json({ ok: out.some(x => x.ok), results: out, keyStart: KEY.trim().slice(0, 10) + '…' }, 200);
  }
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
  // try the chosen model, then fall back if this account can't use it; pass Anthropic's own error back so the owner can see it
  const tries = [...new Set([model, MODEL_QUICK, 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-5-haiku-latest'])];
  let ar = null, lastErr = null;
  for (const m of tries) {
    ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY.trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: m, max_tokens: kind === 'json' ? 8000 : 900, stream: true, messages })
    });
    if (ar.ok && ar.body) break;
    let msg = ''; try { const j = await ar.json(); msg = (j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 200); } catch (_) { msg = 'HTTP ' + ar.status; }
    lastErr = { status: ar.status, detail: `${m}: ${msg}` };
    const modelProblem = ar.status === 404 || /model/i.test(msg);
    if (!modelProblem) break;                                   // key, credit or rate problems won't be fixed by another model
    ar = null;
  }
  if (!ar || !ar.ok || !ar.body) return json({ code: 'upstream', status: lastErr && lastErr.status, detail: lastErr && lastErr.detail }, 502);

  const reader = ar.body.getReader(), enc = new TextEncoder(), dec = new TextDecoder(); let buf = '';
  const stream = new ReadableStream({
    // keep reading until there is text to send: Anthropic's first events (message_start, ping) carry none,
    // and a pull that enqueues nothing would leave the stream waiting forever
    async pull(ctrl) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { ctrl.close(); return; }
        buf += dec.decode(value, { stream: true });
        let i, sent = false;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) { ctrl.enqueue(enc.encode(ev.delta.text)); sent = true; } } catch {}
        }
        if (sent) return;
      }
    },
    cancel() { reader.cancel(); }
  });
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
