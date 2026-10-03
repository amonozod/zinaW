// Zina Voice: natural speech in many languages (incl. Uzbek) through Azure AI Speech.
// Free tier (F0) covers 5 hours of recognition and 0.5M characters of speech a month.
// Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (e.g. "westeurope"), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
export const config = { runtime: 'edge' };
const env = (...names) => (names.map(n => process.env[n]).find(Boolean) || '').trim();
const KEY = env('AZURE_SPEECH_KEY', 'SPEECH_KEY', 'AZURE_KEY'), REGION = env('AZURE_SPEECH_REGION', 'SPEECH_REGION', 'AZURE_REGION').toLowerCase().replace(/\s+/g, '');
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
  if (req.method === 'GET') return json({ configured: !!(KEY && REGION) });
  if (!KEY || !REGION) return json({ code: 'not_configured' }, 500);
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
    if (!r.ok) return json({ code: 'tts_failed', status: r.status, detail: (await r.text()).slice(0, 200) }, 502);
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
