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
  const endpoint = process.env.SPEECH_ENDPOINT;

  if (!key) {
    return res.status(500).json({ error: "SPEECH_KEY is missing" });
  }

  if (!endpoint) {
    return res.status(500).json({ error: "SPEECH_ENDPOINT is missing" });
  }

  const { text = "", lang = "en-US" } = req.body || {};
  const cleanText = String(text).trim();

  if (!cleanText) {
    return res.status(400).json({ error: "Text is required" });
  }

  const locale = VOICES[lang] ? lang : "en-US";
  const voice = VOICES[locale];

  const ssml = `
<speak version="1.0"
  xmlns="http://www.w3.org/2001/10/synthesis"
  xml:lang="${locale}">
  <voice name="${voice}">
    ${escapeXml(cleanText)}
  </voice>
</speak>
`.trim();

  try {
    const azure = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "ZinaTTS"
      },
      body: ssml
    });

    if (!azure.ok) {
      const errorText = await azure.text().catch(() => "");

      console.error(
        "AZURE ERROR:",
        azure.status,
        errorText
      );

      return res.status(azure.status).json({
        error: `Azure ${azure.status}`,
        details: errorText
      });
    }

    const audioBuffer = Buffer.from(
      await azure.arrayBuffer()
    );

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Length",
      String(audioBuffer.length)
    );
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(audioBuffer);

  } catch (error) {
    console.error("FETCH ERROR:", error);

    return res.status(500).json({
      error: "TTS request failed",
      details: error.message
    });
  }
}
