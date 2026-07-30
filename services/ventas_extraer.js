// Extrae el texto de la conversación desde el archivo subido:
// .txt (directo), .zip / .rar (busca el chat exportado; si no hay texto,
// transcribe los audios), o un audio suelto (.opus/.ogg/.mp3/.m4a) con Whisper.
const { log } = require("../config");
const { transcribirAudioWeb } = require("./openai");

const AUDIO_EXT = ["opus", "ogg", "mp3", "m4a", "aac", "wav", "amr"];
const MAX_AUDIOS = 10; // límite para no disparar el costo/tiempo

function extOf(name) { return String(name || "").toLowerCase().split(".").pop(); }
function mimeAudio(ext) { return "audio/" + (ext === "opus" ? "ogg" : ext === "m4a" ? "mp4" : ext); }

async function transcribirVarios(items) {
  // items: [{ buffer, ext }]
  const partes = [];
  let n = 0;
  for (const it of items) {
    if (n >= MAX_AUDIOS) break;
    try {
      const t = await transcribirAudioWeb(it.buffer, mimeAudio(it.ext));
      if (t && t.trim()) partes.push(t.trim());
    } catch (e) { log.warn("[VENTAS_EXTRAER] audio:", e.message); }
    n++;
  }
  return partes.join("\n");
}

async function desdeZip(buffer) {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const textos = [];
  const audios = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const ext = extOf(e.entryName);
    if (ext === "txt") textos.push(e.getData().toString("utf8"));
    else if (AUDIO_EXT.includes(ext)) audios.push({ buffer: e.getData(), ext });
  }
  if (textos.length) return textos.join("\n");
  return await transcribirVarios(audios);
}

async function desdeRar(buffer) {
  try {
    const { createExtractorFromData } = require("node-unrar-js");
    const extractor = await createExtractorFromData({ data: Uint8Array.from(buffer).buffer });
    const list = [...extractor.getFileList().fileHeaders].map(h => h.name);
    const extracted = extractor.extract({ files: list });
    const textos = [];
    const audios = [];
    for (const f of extracted.files) {
      if (!f.extraction) continue;
      const ext = extOf(f.fileHeader.name);
      const buf = Buffer.from(f.extraction);
      if (ext === "txt") textos.push(buf.toString("utf8"));
      else if (AUDIO_EXT.includes(ext)) audios.push({ buffer: buf, ext });
    }
    if (textos.length) return textos.join("\n");
    return await transcribirVarios(audios);
  } catch (e) {
    log.error("[VENTAS_EXTRAER] rar:", e.message);
    throw new Error("No pude leer el .rar. Probá subirlo como .zip o el .txt directo.");
  }
}

async function extraerTextoDeArchivo(buffer, filename, mimetype) {
  const ext = extOf(filename);
  if (ext === "txt") return buffer.toString("utf8");
  if (AUDIO_EXT.includes(ext) || String(mimetype || "").startsWith("audio")) {
    return await transcribirAudioWeb(buffer, mimeAudio(ext) );
  }
  if (ext === "zip") return await desdeZip(buffer);
  if (ext === "rar") return await desdeRar(buffer);
  // Último recurso: intentar como texto plano
  return buffer.toString("utf8");
}

module.exports = { extraerTextoDeArchivo };
