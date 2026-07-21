// ChatGo — Módulo BUS con las 141 líneas REALES de Cochabamba.
//
// Los datos son reales (nombre, destino, sindicato) pero NO tienen el recorrido
// en coordenadas, así que el bot funciona como BUSCADOR POR DESTINO:
//   "¿qué línea me lleva a la Tamborada?" → líneas reales que van ahí.
// El mapa con el recorrido y el micro en vivo llegan cuando el sindicato suma
// su GPS (RastreoPlus). No inventamos rutas.

const { log } = require("../config");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje } = require("../services/whatsapp");
const { buscarPorDestino, buscarPorNombre, totalLineas, TODAS } = require("../services/lineasreales");
const { textoDeMensaje } = require("./util");

const EMOJI_TIPO = { micro: "🚌", minibus: "🚐", trufi: "🚕", tren: "🚈", teleferico: "🚡" };

function formatearLinea(l) {
  const e = EMOJI_TIPO[l.tipo] || "🚌";
  const sind = l.sindicato ? ` · _${l.sindicato}_` : "";
  return `${e} *${l.nombre}* → ${l.hacia}${sind}`;
}

// Extrae el destino de una frase: "qué línea me lleva a la Tamborada" → "Tamborada"
function extraerDestino(texto) {
  if (!texto) return null;
  const m = texto.match(/\b(?:a|hacia|hasta|para)\s+(?:la\s+|el\s+|los\s+|las\s+)?(.+)$/i);
  if (m && m[1] && m[1].trim().length >= 3) return m[1].trim();
  return null;
}

// Responde con las líneas reales que van hacia un destino.
// opts.conservarSesion: llamado desde el cross-sell del taxi (no borra la sesión).
async function responderHacia(phone, destinoTexto, opts = {}) {
  const lineas = buscarPorDestino(destinoTexto);
  if (!lineas.length) {
    if (!opts.conservarSesion) {
      await enviarMensaje(phone,
        `😕 No encontré una línea que vaya a *"${destinoTexto}"*.\n\n` +
        `Probá con el nombre de la zona o avenida (ej: _Tamborada_, _Sacaba_, _Chilimarca_, _Quillacollo_), ` +
        `o escribí *LÍNEAS* para ver todas.`);
    }
    return false;
  }
  const top = lineas.slice(0, 6);
  let msg = `🚌 *Líneas que van a "${destinoTexto}"*\n\n` + top.map(formatearLinea).join("\n") +
    `\n\n💰 Tarifa aprox. *Bs 2.50*`;
  if (lineas.length > top.length) msg += `\n_+${lineas.length - top.length} línea(s) más._`;
  msg += `\n\n_ℹ️ Datos de ${totalLineas()} líneas reales de Cochabamba. El recorrido en el mapa y el micro en vivo llegan cuando el sindicato suma su GPS._`;

  if (opts.conservarSesion) {
    await enviarMensaje(phone, msg + `\n\n🚖 _¿Preferís el taxi? Elegí Auto/Moto/Van arriba 👆_`);
  } else {
    await deleteSession(phone);
    await enviarMensaje(phone, msg);
  }
  return true;
}

async function responderDirectorio(phone) {
  const porTipo = {};
  TODAS.forEach((l) => { (porTipo[l.tipo] = porTipo[l.tipo] || []).push(l.nombre); });
  const nom = { micro: "Microbuses", minibus: "Minibuses", trufi: "Trufis", tren: "Mi Tren", teleferico: "Teleférico" };
  let msg = `🚌 *ChatGo Bus — ${TODAS.length} líneas de Cochabamba*\n\n`;
  for (const t of Object.keys(porTipo)) {
    const lista = porTipo[t];
    msg += `*${nom[t] || t}* (${lista.length}): ${lista.slice(0, 25).join(", ")}${lista.length > 25 ? "…" : ""}\n\n`;
  }
  msg += `_Decime a dónde querés ir y te digo qué línea tomar. Ej: "a la Tamborada"._`;
  await deleteSession(phone);
  await enviarMensaje(phone, msg);
  return true;
}

async function iniciar(phone, msg, session) {
  const { texto } = await textoDeMensaje(msg);
  if (texto && /^(lineas|l[ií]neas|todas|lista)$/i.test(texto.trim())) return await responderDirectorio(phone);
  // Si la pregunta ya trae el destino ("qué línea me lleva a la Tamborada"), responder directo
  const destino = extraerDestino(texto);
  if (destino) return await responderHacia(phone, destino);
  await updateSession(phone, { ...(session || {}), modulo: "bus", step: "mod_bus_destino" });
  await enviarMensaje(phone,
    `🚌 *ChatGo Bus*\n\n¿A dónde querés ir? Decime la zona o avenida.\n\n` +
    `_Ej: "a la Tamborada", "a Sacaba", "a Chilimarca"._\n\n` +
    `Escribí *LÍNEAS* para ver todas · *CANCELAR* para salir.`);
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);
  if (/^cancelar$/i.test((texto || "").trim())) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Listo. Escribí *bus* cuando quieras saber qué línea te lleva. 🚌");
    return true;
  }
  if (/^(lineas|l[ií]neas|todas|lista)$/i.test((texto || "").trim())) return await responderDirectorio(phone);
  if (!texto) { await enviarMensaje(phone, "🙏 Decime a qué zona querés ir (ej: _a la Tamborada_)."); return true; }
  const destino = extraerDestino(texto) || texto.trim();
  return await responderHacia(phone, destino);
}

// Cross-sell desde el taxi: usa el NOMBRE del destino del viaje para sugerir líneas.
async function responderLinea(phone, origen, destino, opts = {}) {
  const destTxt = destino?.nombre || "";
  if (!destTxt || destTxt.length < 3) return false;
  return await responderHacia(phone, destTxt, opts);
}

// ¿Hay alguna línea real que vaya al destino? (para decidir el cross-sell del taxi)
function hayLineaHacia(destinoTexto) {
  return buscarPorDestino(destinoTexto || "").length > 0;
}

module.exports = { id: "bus", iniciar, procesar, responderLinea, hayLineaHacia };
