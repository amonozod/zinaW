// api/tts.js

const VOICES = {
  "en-US": "en-US-JennyNeural",
  "uz-UZ": "uz-UZ-SardorNeural",
  "ru-RU": "ru-RU-SvetlanaNeural"
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.SPEECH_KEY;
  const endpoint =
    process.env.SPEECH_ENDPOINT ||
    "https://northeurope.tts.speech.microsoft.com/cognitiveservices/v1";

  if (!key) {
    return res.status(500).json({ error: "SPEECH_KEY is missing" });
  }

  const { text = "", lang = "en-US" } = req.body || {};

  if (!String(text).trim()) {
    return res.status(400).json({ error: "Text is required" });
  }

  const locale = VOICES[lang] ? lang : "en-US";
  const voice = VOICES[locale];

  const ssml = `
<speak version="1.0"
  xmlns="http://www.w3.org/2001/10/synthesis"
  xml:lang="${locale}">
  <voice name="${voice}">
    ${escapeXml(String(text))}
  </voice>
</speak>`.trim();

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"
      },
      body: ssml
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      console.error("Azure TTS:", r.status, err);

      return res.status(r.status).json({
        error: `Azure TTS failed: ${r.status}`
      });
    }

    const audio = Buffer.from(await r.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));

    return res.status(200).send(audio);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "TTS request failed"
    });
  }
}
