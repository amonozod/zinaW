// api/tts.js
// Vercel Serverless Function -> Azure Speech Text-to-Speech

const VOICES = {
  "en-US": "en-US-JennyNeural",
  "uz-UZ": "uz-UZ-MadinaNeural",
  "ru-RU": "ru-RU-SvetlanaNeural"
};

const EMOTION = {
  calm:        { rate: "-2%", pitch: "0%" },
  happy:       { rate: "4%",  pitch: "+4%" },
  laughing:    { rate: "8%",  pitch: "+7%" },
  excited:     { rate: "10%", pitch: "+8%" },
  encouraging: { rate: "3%",  pitch: "+3%" },
  love:        { rate: "-2%", pitch: "+5%" },
  proud:       { rate: "1%",  pitch: "+2%" },
  thinking:    { rate: "-8%", pitch: "-2%" },
  surprised:   { rate: "7%",  pitch: "+8%" },
  concerned:   { rate: "-4%", pitch: "-2%" },
  sad:         { rate: "-8%", pitch: "-4%" },
  crying:      { rate: "-10%", pitch: "-5%" },
  angry:       { rate: "8%",  pitch: "-4%" },
  scolding:    { rate: "6%",  pitch: "-3%" },
  sleepy:      { rate: "-12%", pitch: "-2%" }
};

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return jsonError(res, 405, "Method not allowed");
  }

  try {
    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION || "northeurope";
    const configuredEndpoint = process.env.SPEECH_ENDPOINT;

    if (!key) {
      return jsonError(res, 500, "SPEECH_KEY is not configured");
    }

    let text = "";
    let lang = "en-US";
    let emo = "calm";

    if (req.body && typeof req.body === "object") {
      text = String(req.body.text || "");
      lang = String(req.body.lang || "en-US");
      emo = String(req.body.emo || "calm");
    } else {
      return jsonError(res, 400, "Invalid JSON body");
    }

    text = text.trim();

    if (!text) {
      return jsonError(res, 400, "Text is required");
    }

    // Prevent accidentally sending huge text to TTS.
    if (text.length > 2500) {
      text = text.slice(0, 2500);
    }

    const locale = VOICES[lang] ? lang : "en-US";
    const voice = VOICES[locale];

    const style = EMOTION[emo] || EMOTION.calm;

    // Your Azure resource endpoint:
    // https://zinaspeech.cognitiveservices.azure.com/
    //
    // Azure TTS POST endpoint:
    // /cognitiveservices/v1
    let base;

    if (configuredEndpoint) {
      base = configuredEndpoint.replace(/\/+$/, "");
    } else {
      base = `https://${region}.tts.speech.microsoft.com`;
    }

    let ttsUrl;

    if (/\/cognitiveservices\/v1$/i.test(base)) {
      ttsUrl = base;
    } else {
      ttsUrl = `${base}/cognitiveservices/v1`;
    }

    const ssml = `
<speak version="1.0"
       xmlns="http://www.w3.org/2001/10/synthesis"
       xml:lang="${locale}">
  <voice name="${voice}">
    <prosody rate="${style.rate}" pitch="${style.pitch}">
      ${xmlEscape(text)}
    </prosody>
  </voice>
</speak>`.trim();

    const azureResponse = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "Zina-TTS"
      },
      body: ssml
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text().catch(() => "");
      console.error("Azure Speech error:", azureResponse.status, errorText);

      return jsonError(
        res,
        azureResponse.status,
        `Azure Speech failed (${azureResponse.status})`
      );
    }

    const audioBuffer = Buffer.from(await azureResponse.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audioBuffer.length));
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(audioBuffer);
  } catch (error) {
    console.error("TTS server error:", error);
    return jsonError(res, 500, "TTS server error");
  }
};
