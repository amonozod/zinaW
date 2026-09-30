/* Zina production bridge: gives the app the same db / user / sample interface it uses inside Claude,
   backed by Supabase (data, auth, realtime) and /api/ai (Claude via your own API key). */
(function () {
  const C = window.ZINA_CONFIG;
  if (!C || !C.supabaseUrl || /YOUR[-_]/.test(C.supabaseUrl + C.supabaseAnonKey) || !window.supabase) return;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const session = async () => (await sb.auth.getSession()).data.session;
  const colOf = p => p.split('/').slice(0, -1).join('/');
  const idOf = p => p.split('/').pop();
  const COLS = 'path,collection,doc_id,data';

  /* one realtime channel for the whole table, fanned out to listeners */
  const listeners = new Set(); let chan = null;
  function hub() {
    if (chan) return;
    chan = sb.channel('zina-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        const row = (p.new && p.new.path) ? p.new : p.old;
        listeners.forEach(fn => fn(p.eventType, row));
      }).subscribe();
  }
  function mapErr(e) {
    const x = new Error(e.message || 'Request failed');
    x.code = /row-level security|permission|not allowed|violates/i.test(e.message || '') ? 'invalid_argument' : 'unavailable';
    return x;
  }
  const snap = r => ({ id: r.doc_id, data: () => r.data });

  const ME = /^data\/users\/me(?=\/|$)/;
  async function realPath(path) { if (!ME.test(path)) return path; const s = await session(); return path.replace(ME, 'data/users/' + (s ? s.user.id : 'anon')); }
  function docRef(path0) {
    if (ME.test(path0)) return meRef(path0);
    const path = path0, col = colOf(path), id = idOf(path);
    return {
      id,
      async set(data) {
        const { error } = await sb.from('docs').upsert({ path, collection: col, doc_id: id, data, updated_at: new Date().toISOString() });
        if (error) throw mapErr(error);
      },
      async update(patch) {
        if (col === 'posts' && Object.keys(patch).length === 1 && 'likes' in patch) {
          const { error } = await sb.rpc('toggle_like', { p_path: path }); if (error) throw mapErr(error); return;
        }
        const { error } = await sb.rpc('merge_doc', { p_path: path, p_patch: patch }); if (error) throw mapErr(error);
      },
      async delete() {
        const { error } = await sb.from('docs').delete().eq('path', path); if (error) throw mapErr(error);
      },
      onSnapshot(cb, err) {
        let alive = true, row = null;
        const emit = () => cb({ exists: !!row, id, data: () => (row ? row.data : undefined) });
        (async () => {
          const { data, error } = await sb.from('docs').select(COLS).eq('path', path).maybeSingle();
          if (!alive) return; if (error) { err && err(mapErr(error)); return; }
          row = data; emit();
        })();
        hub();
        const fn = (t, r) => { if (!r || r.path !== path) return; row = t === 'DELETE' ? null : r; emit(); };
        listeners.add(fn);
        return () => { alive = false; listeners.delete(fn); };
      }
    };
  }
  function meRef(path0) {           // the signed-in student's private data (data/users/me/...)
    const ref = () => realPath(path0).then(p => docRef(p));
    return {
      id: idOf(path0),
      set: d => ref().then(r => r.set(d)),
      update: d => ref().then(r => r.update(d)),
      delete: () => ref().then(r => r.delete()),
      onSnapshot(cb, err) { let un = null, dead = false; ref().then(r => { if (!dead) un = r.onSnapshot(cb, err); }); return () => { dead = true; un && un(); }; }
    };
  }
  function query(col, o = {}) {
    return {
      orderBy(field, dir = 'asc') { return query(col, { ...o, order: [field, dir] }); },
      limit(n) { return query(col, { ...o, limit: n }); },
      where() { return query(col, o); },
      doc(id) { return docRef(col + '/' + id); },
      onSnapshot(cb, err) {
        const map = new Map(); let alive = true;
        const emit = () => {
          let rows = [...map.values()];
          if (o.order) { const [f, d] = o.order; rows.sort((a, b) => { const x = a.data[f], y = b.data[f]; return (x > y ? 1 : x < y ? -1 : 0) * (d === 'desc' ? -1 : 1); }); }
          else rows.sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1));
          if (o.limit) rows = rows.slice(0, o.limit);
          cb({ docs: rows.map(snap), size: rows.length, empty: !rows.length });
        };
        (async () => {
          let from = 0; const page = 1000;
          for (;;) {
            const { data, error } = await sb.from('docs').select(COLS).eq('collection', col).order('updated_at', { ascending: false }).range(from, from + page - 1);
            if (!alive) return; if (error) { err && err(mapErr(error)); return; }
            data.forEach(r => map.set(r.path, r));
            if (data.length < page || (o.limit && map.size >= o.limit * 2)) break; from += page;
          }
          emit();
        })();
        hub();
        const fn = (t, r) => { if (!r || colOf(r.path) !== col) return; if (t === 'DELETE') map.delete(r.path); else map.set(r.path, r); emit(); };
        listeners.add(fn);
        return () => { alive = false; listeners.delete(fn); };
      }
    };
  }
  const db = { collection: c => query(c), doc: p => docRef(p) };

  let adminP = null;
  const isAdmin = () => (adminP = adminP || sb.rpc('is_admin').then(r => !!r.data).catch(() => false));
  const user = {
    async id() { const s = await session(); return s ? s.user.id : null; },
    async name() { const s = await session(); if (!s) return ''; const m = s.user.user_metadata || {}; return m.full_name || m.name || (s.user.email || '').split('@')[0]; },
    async isOwner() { return isAdmin(); },
    async canEdit() { return isAdmin(); },
    async profiles(ids) {
      const { data } = await sb.from('profiles').select('id,name').in('id', ids);
      const out = {}; (data || []).forEach(r => { out[r.id] = { name: r.name || '' }; }); return out;
    }
  };

  async function sample(input, opts = {}) {
    const s = await session();
    if (!s) throw Object.assign(new Error('Sign in first'), { code: 'not_granted' });
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    let images = [];
    if (opts.images) {
      const list = opts.images instanceof Blob ? [opts.images] : [...opts.images];
      images = await Promise.all(list.slice(0, 6).map(b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res({ media_type: b.type || 'image/jpeg', data: String(fr.result).split(',')[1] }); fr.onerror = rej; fr.readAsDataURL(b); })));
    }
    const r = await fetch(C.aiEndpoint || '/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + s.access_token },
      body: JSON.stringify({ messages, images, tier: opts.modelTier || 'quick', kind: opts._kind || 'chat' })
    });
    if (!r.ok) {
      let server = '', detail = ''; try { const j = await r.json(); server = j.code || ''; detail = j.detail || ''; } catch (_) {}
      const code = server === 'not_configured' ? 'not_configured' : r.status === 429 ? 'rate_limited' : r.status === 403 || r.status === 401 ? 'not_granted' : 'unavailable';
      throw Object.assign(new Error(detail ? `${server || code} (${detail})` : (server || code)), { code, detail });
    }
    const rd = r.body.getReader(), dec = new TextDecoder(); let text = '';
    for (;;) { const { done, value } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); opts.onText && opts.onText({ text }); }
    return { text };
  }
  sample.limits = async () => ({ maxInputBytes: 65536, images: { maxCount: 3, maxBytes: 4_000_000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } });
  sample.json = async (prompt, opts = {}) => {
    const r = await sample(prompt + '\n\nRespond with valid JSON only. No prose, no code fences.', { ...opts, _kind: 'json' });
    const t = r.text.replace(/```json|```/g, '').trim(); const i = t.search(/[\[{]/);
    return JSON.parse(t.slice(i));
  };

  function effectivePlan(p) {
    const now = Date.now();
    if (p.plan && p.plan !== 'free' && (!p.paid_until || Date.parse(p.paid_until) > now)) return p.plan;
    if (p.trial_until && Date.parse(p.trial_until) > now) return 'pro';
    return 'free';
  }
  async function profile() {
    const s = await session(); if (!s) return null;
    const { data } = await sb.from('profiles').select('plan,paid_until,trial_until,trial_used').eq('id', s.user.id).maybeSingle();
    return data;
  }

  window.ZINA = { sb, config: C, profile: async () => null, effectivePlan };
  window.claude = { use: async name => (name === 'db' ? db : name === 'user' ? user : name === 'sample' ? sample : null) };
})();
