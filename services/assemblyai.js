// ChatGo — AssemblyAI (transcripción de consultas médicas: diarización + Medical Mode)
// Prioridad del médico: separar bien quién habla (médico vs paciente).
// speaker_labels hace la diarización; domain=medical-v1 + keyterms_prompt afinan
// el reconocimiento de fármacos y términos clínicos en español.
const axios = require("axios");
const { CONFIG, log } = require("../config");

const KEYTERMS_MEDICOS_ES = [
  "paracetamol", "ibuprofeno", "amoxicilina", "diclofenaco", "omeprazol",
  "loratadina", "metformina", "losartán", "atorvastatina", "azitromicina",
  "ciprofloxacino", "prednisona", "salbutamol", "insulina", "warfarina",
  "hipertensión", "diabetes", "gastritis", "faringitis", "bronquitis",
  "presión arterial", "glucosa", "colesterol", "electrocardiograma",
  "radiografía", "resonancia magnética", "tomografía", "biopsia",
];

async function subirAudio(audioBuffer) {
  const res = await axios.post("https://api.assemblyai.com/v2/upload", audioBuffer, {
    headers: { Authorization: CONFIG.ASSEMBLYAI_API_KEY, "Content-Type": "application/octet-stream" },
    timeout: CONFIG.TIMEOUT_ASSEMBLYAI,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data.upload_url;
}

async function pedirTranscripcion(audioUrl) {
  const res = await axios.post(
    "https://api.assemblyai.com/v2/transcript",
    {
      audio_url: audioUrl,
      language_code: "es",
      speaker_labels: true,
      domain: "medical-v1",
      keyterms_prompt: KEYTERMS_MEDICOS_ES,
    },
    {
      headers: { Authorization: CONFIG.ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
      timeout: CONFIG.TIMEOUT_ASSEMBLYAI,
    }
  );
  return res.data.id;
}

async function esperarTranscripcion(id) {
  const inicio = Date.now();
  while (Date.now() - inicio < CONFIG.TIMEOUT_TRANSCRIPCION_TOTAL) {
    const res = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: CONFIG.ASSEMBLYAI_API_KEY },
      timeout: CONFIG.TIMEOUT_ASSEMBLYAI,
    });
    if (res.data.status === "completed") return res.data;
    if (res.data.status === "error") throw new Error(res.data.error || "AssemblyAI falló al transcribir");
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Tiempo de espera agotado transcribiendo el audio");
}

async function transcribirConsultaMedica(audioBuffer) {
  if (!CONFIG.ASSEMBLYAI_API_KEY) {
    throw new Error("ASSEMBLYAI_API_KEY no configurado");
  }

  const audioUrl = await subirAudio(audioBuffer);
  const id = await pedirTranscripcion(audioUrl);
  const data = await esperarTranscripcion(id);

  const segmentos = (data.utterances || []).map(u => ({
    hablante: u.speaker,   // "A", "B"... AssemblyAI no sabe cuál es médico/paciente
    texto: u.text,
    inicioSeg: u.start / 1000,
    finSeg: u.end / 1000,
  }));

  return {
    transcripcionCompleta: data.text || "",
    segmentos,
    duracionSegundos: data.audio_duration || null,
  };
}

module.exports = { transcribirConsultaMedica };
