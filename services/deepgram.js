// ChatGo — Deepgram (transcripción de consultas médicas, con diarización)
const axios = require("axios");
const { CONFIG, log } = require("../config");

// Transcribe una consulta médica larga y separa hablantes (médico/paciente).
// audioBuffer: bytes crudos del audio (ogg/wav/mp3/m4a/webm, lo que mande el cliente)
// mimetype: content-type del audio, ej "audio/ogg"
async function transcribirConsultaMedica(audioBuffer, mimetype) {
  if (!CONFIG.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY no configurado");
  }

  const res = await axios.post(
    "https://api.deepgram.com/v1/listen",
    audioBuffer,
    {
      params: {
        model: "nova-3",
        language: "es",
        diarize: true,
        punctuate: true,
        smart_format: true,
        paragraphs: true,
      },
      headers: {
        Authorization: `Token ${CONFIG.DEEPGRAM_API_KEY}`,
        "Content-Type": mimetype || "audio/ogg",
      },
      timeout: CONFIG.TIMEOUT_DEEPGRAM,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  const alt = res.data?.results?.channels?.[0]?.alternatives?.[0];
  const transcripcionCompleta = alt?.transcript || "";
  const duracionSegundos = res.data?.metadata?.duration || null;

  const parrafos = alt?.paragraphs?.paragraphs || [];
  const segmentos = parrafos.map(p => ({
    hablante: p.speaker,
    texto: (p.sentences || []).map(s => s.text).join(" "),
    inicioSeg: p.start,
    finSeg: p.end,
  }));

  return { transcripcionCompleta, segmentos, duracionSegundos };
}

module.exports = { transcribirConsultaMedica };
