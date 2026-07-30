// Conector de WhatsApp por Baileys para Evaluación de Ventas.
// AISLADO de ChatGo: cada vendedor enlaza SU línea (dispositivo vinculado, como
// WhatsApp Web) escaneando un QR una sola vez. Todo mensaje entrante y saliente
// entra en vivo, se acumula por conversación (vendedor ↔ cliente) y se auto-evalúa
// solo los mensajes nuevos cuando la conversación queda inactiva un rato.
//
// No usa la instancia de ChatGo (Green API). No comparte credenciales ni número.
const path = require("path");
const fs = require("fs");
const { CONFIG, log } = require("../config");
const { LineaVentas, ChatVentas, Vendedor } = require("../db/models");
const { evaluarChat } = require("./ventas_evaluar");

// Logger mínimo que Baileys espera (evita acoplarnos a pino).
const mudo = { level: "silent", fatal(){}, error(){}, warn(){}, info(){}, debug(){}, trace(){}, child(){ return mudo; } };

let BAILEYS = null; // se carga perezosamente para no romper si no está instalado
let QRLIB = null;
const sesiones = new Map(); // lineaId -> { sock, estado, qr, qrDataUrl, numero, timers:Map }

function cargarLibs() {
  if (BAILEYS) return true;
  try {
    BAILEYS = require("@whiskeysockets/baileys");
    try { QRLIB = require("qrcode"); } catch (_) { QRLIB = null; }
    return true;
  } catch (e) {
    log.warn("[VENTAS_WA] Baileys no está instalado (npm i @whiskeysockets/baileys qrcode). Enlace en vivo deshabilitado.");
    return false;
  }
}

function dirLinea(lineaId) {
  const base = path.isAbsolute(CONFIG.VENTAS_WA_DIR) ? CONFIG.VENTAS_WA_DIR : path.join(process.cwd(), CONFIG.VENTAS_WA_DIR);
  return path.join(base, lineaId);
}

function estadoPublico(lineaId) {
  const s = sesiones.get(lineaId);
  if (!s) return { estado: "desconectado", qr: null, numero: null };
  return { estado: s.estado, qr: s.qrDataUrl || null, numero: s.numero || null };
}

// Extrae el texto legible de un mensaje de Baileys (o una etiqueta para media).
function textoDeMensaje(m) {
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? m.imageMessage.caption : "[imagen]";
  if (m.videoMessage) return m.videoMessage.caption ? m.videoMessage.caption : "[video]";
  if (m.audioMessage || m.pttMessage) return "[nota de voz]";
  if (m.documentMessage) return "[documento]";
  if (m.locationMessage) return "[ubicación]";
  if (m.stickerMessage) return "[sticker]";
  return "";
}

function ts(segundos) {
  try {
    const d = segundos ? new Date(Number(segundos) * 1000) : new Date();
    return d.toLocaleString("es-BO", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

// Acumula un mensaje en la transcripción de la conversación y programa la evaluación.
async function registrarMensaje(lineaId, vendedorNombre, clienteJid, clienteNombre, quien, texto, segundos) {
  if (!texto || !texto.trim()) return;
  const autor = quien === "vendedor" ? (vendedorNombre || "Vendedor") : (clienteNombre || "Cliente");
  const linea = `[${ts(segundos)}] ${autor}: ${texto.replace(/\s+/g, " ").trim()}`;

  const prev = await ChatVentas.findUnique({ where: { lineaId_clienteJid: { lineaId, clienteJid } } });
  const acumulado = ((prev && prev.texto) ? prev.texto + "\n" : "") + linea;
  const datos = {
    clienteNombre: clienteNombre || (prev && prev.clienteNombre) || null,
    texto: acumulado.slice(-60000),
    ultimoMsgAt: new Date(),
    pendiente: true,
  };
  await ChatVentas.upsert({
    where: { lineaId_clienteJid: { lineaId, clienteJid } },
    update: datos,
    create: { lineaId, clienteJid, ...datos },
  });

  programarEvaluacion(lineaId, clienteJid);
}

// Debounce: evalúa cuando la conversación queda inactiva VENTAS_WA_DEBOUNCE_MS.
function programarEvaluacion(lineaId, clienteJid) {
  const s = sesiones.get(lineaId);
  if (!s) return;
  const key = clienteJid;
  if (s.timers.has(key)) clearTimeout(s.timers.get(key));
  s.timers.set(key, setTimeout(() => {
    s.timers.delete(key);
    evaluarConversacion(lineaId, clienteJid).catch(e => log.error("[VENTAS_WA] eval:", e.message));
  }, Math.max(15000, CONFIG.VENTAS_WA_DEBOUNCE_MS)));
}

async function evaluarConversacion(lineaId, clienteJid) {
  const chat = await ChatVentas.findUnique({ where: { lineaId_clienteJid: { lineaId, clienteJid } } });
  if (!chat || !chat.pendiente || !chat.texto || chat.texto.trim().length < 40) return;
  const linea = await LineaVentas.findUnique({ where: { id: lineaId } });
  if (!linea) return;
  const vendedor = await Vendedor.findUnique({ where: { id: linea.vendedorId } });
  if (!vendedor) return;

  try {
    const r = await evaluarChat(vendedor, chat.texto, "", chat.ultimoMsgAt || new Date(), "wa:" + clienteJid);
    log.info(`[VENTAS_WA] Auto-evaluación ${vendedor.nombre} ↔ ${chat.clienteNombre || clienteJid}: ${r.evaluacion.promedio}/10 (${r.tipo})`);
  } catch (e) {
    // REPETIDO / SIN_NUEVOS: no hay nada nuevo real que calificar -> silencioso.
    if (e.code !== "REPETIDO" && e.code !== "SIN_NUEVOS") log.error("[VENTAS_WA] evaluarChat:", e.message);
  }
  await ChatVentas.update({ where: { id: chat.id }, data: { pendiente: false } }).catch(() => {});
}

// Levanta (o relevanta) la sesión Baileys de una línea.
async function iniciarLinea(lineaId) {
  if (!cargarLibs()) throw new Error("El enlace por WhatsApp no está disponible en el servidor (falta instalar @whiskeysockets/baileys).");
  const linea = await LineaVentas.findUnique({ where: { id: lineaId } });
  if (!linea) throw new Error("Línea no encontrada.");
  const vendedor = await Vendedor.findUnique({ where: { id: linea.vendedorId } });
  const vendedorNombre = vendedor ? vendedor.nombre : "Vendedor";

  // Si ya hay una sesión conectada, no la duplicamos.
  const existente = sesiones.get(lineaId);
  if (existente && existente.estado === "conectado") return estadoPublico(lineaId);

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = BAILEYS;
  const dir = dirLinea(lineaId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {}

  const sock = makeWASocket({ version, auth: state, logger: mudo, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false });
  const s = existente || { timers: new Map() };
  s.sock = sock; s.estado = "conectando"; s.qr = null; s.qrDataUrl = null;
  sesiones.set(lineaId, s);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      s.qr = qr; s.estado = "qr";
      if (QRLIB) { try { s.qrDataUrl = await QRLIB.toDataURL(qr, { margin: 1, width: 300 }); } catch (_) {} }
      await LineaVentas.update({ where: { id: lineaId }, data: { estado: "qr" } }).catch(() => {});
    }
    if (connection === "open") {
      s.estado = "conectado"; s.qr = null; s.qrDataUrl = null;
      s.numero = (sock.user && sock.user.id) ? String(sock.user.id).split(":")[0] : null;
      await LineaVentas.update({ where: { id: lineaId }, data: { estado: "conectado", numero: s.numero } }).catch(() => {});
      log.info(`[VENTAS_WA] Línea conectada: ${vendedorNombre} (${s.numero || "?"})`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const cerradaSesion = code === DisconnectReason.loggedOut;
      s.estado = cerradaSesion ? "desconectado" : "conectando";
      await LineaVentas.update({ where: { id: lineaId }, data: { estado: s.estado } }).catch(() => {});
      if (cerradaSesion) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        log.warn(`[VENTAS_WA] Sesión cerrada (logout) en línea ${lineaId}. Hay que re-escanear el QR.`);
      } else {
        log.warn(`[VENTAS_WA] Reconectando línea ${lineaId} (code ${code})…`);
        setTimeout(() => iniciarLinea(lineaId).catch(() => {}), 4000);
      }
    }
  });

  sock.ev.on("messages.upsert", async (ev) => {
    log.info(`[VENTAS_WA] upsert type=${ev.type} n=${ev.messages.length} linea=${lineaId}`);
    // "notify" = mensajes nuevos en vivo. "append" = agregados (incluye algunos propios).
    if (ev.type !== "notify" && ev.type !== "append") return;
    for (const msg of ev.messages) {
      try {
        const jid = msg.key.remoteJid || "";
        const texto = textoDeMensaje(msg.message);
        if (!jid.endsWith("@s.whatsapp.net")) { log.info(`[VENTAS_WA] salto jid=${jid} (no es chat 1-a-1)`); continue; }
        if (!texto) { log.info(`[VENTAS_WA] salto jid=${jid} (sin texto)`); continue; }
        const quien = msg.key.fromMe ? "vendedor" : "cliente";
        const clienteNombre = msg.key.fromMe ? null : (msg.pushName || null);
        log.info(`[VENTAS_WA] captado jid=${jid} de=${quien}`);
        await registrarMensaje(lineaId, vendedorNombre, jid, clienteNombre, quien, texto, msg.messageTimestamp);
      } catch (e) { log.error("[VENTAS_WA] msg:", e.message); }
    }
  });

  return estadoPublico(lineaId);
}

async function desconectarLinea(lineaId) {
  const s = sesiones.get(lineaId);
  if (s && s.sock) { try { await s.sock.logout(); } catch (_) {} }
  try { fs.rmSync(dirLinea(lineaId), { recursive: true, force: true }); } catch (_) {}
  sesiones.delete(lineaId);
  await LineaVentas.update({ where: { id: lineaId }, data: { estado: "desconectado" } }).catch(() => {});
}

// Al arrancar el servidor: relevanta las líneas activas que ya tenían credenciales.
async function init() {
  if (!CONFIG.VENTAS_WA_ENABLED) { log.info("[VENTAS_WA] Enlace en vivo deshabilitado (VENTAS_WA_ENABLED != 1)."); return; }
  if (!cargarLibs()) return;
  let lineas = [];
  try { lineas = await LineaVentas.findMany({ where: { activa: true } }); } catch (_) { return; }
  for (const l of lineas) {
    // Solo relevantamos si ya hay credenciales guardadas (si no, espera el QR manual).
    if (fs.existsSync(path.join(dirLinea(l.id), "creds.json"))) {
      iniciarLinea(l.id).catch(e => log.error("[VENTAS_WA] init:", e.message));
    }
  }
  log.info(`[VENTAS_WA] Enlace en vivo activo (${lineas.length} línea(s) registradas).`);
}

module.exports = { init, iniciarLinea, desconectarLinea, estadoPublico, disponible: () => cargarLibs() };
