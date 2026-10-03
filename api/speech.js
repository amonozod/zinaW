// Zina Voice: natural speech in many languages (incl. Uzbek) through Azure AI Speech.
// Free tier (F0) covers 5 hours of recognition and 0.5M characters of speech a month.
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (e.g. "westeurope"), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
export const config = { runtime: 'edge' };
const vals = (...names) => [...new Set(names.map(n => (process.env[n] || '').trim()).filter(Boolean))];
const KEYS = vals('AZURE_SPEECH_KEY', 'SPEECH_KEY', 'AZURE_KEY');
const REGIONS = vals('AZURE_SPEECH_REGION', 'SPEECH_REGION', 'AZURE_REGION').map(r => r.toLowerCase().replace(/\s+/g, ''));
const COMMON = ['northeurope', 'westeurope', 'eastus', 'eastus2', 'westus', 'westus2', 'centralindia', 'southeastasia', 'uksouth', 'francecentral', 'germanywestcentral', 'swedencentral', 'switzerlandnorth', 'uaenorth', 'japaneast', 'koreacentral', 'australiaeast', 'canadacentral', 'centralus', 'southcentralus', 'westcentralus', 'eastasia', 'brazilsouth', 'norwayeast', 'qatarcentral'];
let KEY = KEYS[0] || '', REGION = REGIONS[0] || '', PAIR_OK = false;
// find which key/region pair Azure accepts (a key only works in the region of its resource); remembered while the server is warm
async function pickPair() {
  if (PAIR_OK) return true;
  const regions = [...new Set([...REGIONS, ...COMMON])];
  for (const k of KEYS) for (const r of regions) {
    try { const res = await fetch(`https://${r}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': k, 'Content-Length': '0' } });
      if (res.ok) { KEY = k; REGION = r; PAIR_OK = true; return true; } } catch (_) {}
  }
  return false;
}
const SB = process.env.SUPABASE_URL, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const VOICES = { 'uz-UZ': 'uz-UZ-MadinaNeural', 'ru-RU': 'ru-RU-SvetlanaNeural', 'en-US': 'en-US-JennyNeural', 'tr-TR': 'tr-TR-EmelNeural', 'kk-KZ': 'kk-KZ-AigulNeural',
  'es-ES': 'es-ES-ElviraNeural', 'fr-FR': 'fr-FR-DeniseNeural', 'de-DE': 'de-DE-KatjaNeural', 'ar-SA': 'ar-SA-ZariyahNeural', 'hi-IN': 'hi-IN-SwaraNeural', 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'ko-KR': 'ko-KR-SunHiNeural', 'ja-JP': 'ja-JP-NanamiNeural' };
const STYLE = { happy: 'cheerful', laughing: 'cheerful', excited: 'excited', encouraging: 'friendly', love: 'friendly', proud: 'cheerful', sad: 'sad', crying: 'sad', concerned: 'empathetic', angry: 'angry', scolding: 'angry', calm: 'friendly', thinking: 'friendly', surprised: 'excited', sleepy: 'whispering' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function authed(req) {
  const auth = req.headers.get('authorization') || ''; if (!auth.startsWith('Bearer ') || !SB) return false;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: auth, apikey: SRK } }); return r.ok;
}
export default async function handler(req) {
  const url = new URL(req.url); const op = url.searchParams.get('op');
  if (req.method === 'GET') return json({ configured: !!(KEYS.length && (REGIONS.length || true)) });
  if (!KEYS.length) return json({ code: 'not_configured' }, 500);
  if (!(await pickPair())) return json({ code: 'tts_failed', status: 401, detail: 'Azure rejected the key in every region. Copy KEY 1 again from the Speech resource (Keys and Endpoint) and redeploy.' }, 502);
  if (!(await authed(req))) return json({ code: 'unauthorized' }, 401);
  if (op === 'tts') {
    const { text = '', lang = 'en-US', emo = 'calm' } = await req.json().catch(() => ({}));
    // a native neural voice for each language pronounces it correctly; English also gets an emotional speaking style
    const voice = VOICES[lang] || VOICES['en-US'];
    const body = esc(text.slice(0, 1200));
    const style = lang === 'en-US' ? STYLE[emo] : null;
    const inner = style ? `<mstts:express-as style="${style}">${body}</mstts:express-as>` : body;
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}">${inner}</voice></speak>`;
    const r = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'zina' }, body: ssml });
    if (!r.ok) {
      const raw = (await r.text()).slice(0, 160);
      const why = r.status === 401 ? 'the key does not match this region (HTTP 401). Use KEY 1 from the same Speech resource, and its Location as the region'
        : r.status === 403 ? 'access denied (HTTP 403): the resource may be disabled or the key revoked'
        : r.status === 404 ? `region "${REGION}" not found (HTTP 404): check the Location on the resource page`
        : r.status === 429 ? 'the free monthly limit or rate limit was reached (HTTP 429)'
        : r.status === 400 ? `the request was rejected (HTTP 400) ${raw}`
        : `HTTP ${r.status} ${raw}`;
      return json({ code: 'tts_failed', status: r.status, detail: why }, 502);
    }
    return new Response(r.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
  }
  if (op === 'stt') {
    const langs = (url.searchParams.get('langs') || 'uz-UZ,en-US,ru-RU').split(',').slice(0, 3);
    const audio = await req.arrayBuffer();
    // ask each candidate language at the same time and keep the most confident transcript
    const tries = await Promise.all(langs.map(async lang => {
      try {
        const r = await fetch(`https://${REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}&format=detailed`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', 'Accept': 'application/json' }, body: audio });
        if (!r.ok) return null; const j = await r.json(); const best = j.NBest && j.NBest[0];
        return j.RecognitionStatus === 'Success' && j.DisplayText ? { text: j.DisplayText, lang, confidence: best ? best.Confidence : 0.5 } : null;
      } catch { return null; }
    }));
    const best = tries.filter(Boolean).sort((a, b) => b.confidence - a.confidence)[0];
    if (best && best.confidence > 0.35) return json(best);
    return json({ text: '', lang: null });
  }
  return json({ code: 'bad_request' }, 400);
}
