// ChatGo Salud — WhatsApp de reservas de Vitalis, corriendo directo en este
// mismo proceso Node con Baileys (protocolo de WhatsApp Web) — sin Docker,
// Postgres ni un servicio aparte como Evolution API. Es un cliente NO
// oficial: Meta podría banear el número si detecta uso automatizado, por
// eso conviene un número aparte, nunca el que usás a diario.
//
// La sesión (las llaves de cifrado del "dispositivo vinculado") se guarda
// en una carpeta local (uploads/baileys_auth/, fuera de git). Si el disco
// del servidor se pierde o se migra sin copiar esa carpeta, hay que volver
// a escanear el QR — no se pierde ninguna cita ni dato clínico, solo la
// sesión de WhatsApp.
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const { CONFIG, log } = require("../config");
const { procesarMensajeEntrante } = require("./reservaCitas");

const AUTH_DIR = path.join(__dirname, "..", "uploads", "baileys_auth");
fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let ultimoQR = null;
let conectado = false;
let iniciando = false;

async function iniciarWhatsapp() {
  if (!CONFIG.SALUD_WHATSAPP_MEDICO_PHONE) {
    log.info("[VITALIS_WHATSAPP] SALUD_WHATSAPP_MEDICO_PHONE no configurado — no se inicia WhatsApp de Vitalis");
    return;
  }
  if (iniciando) return;
  iniciando = true;

  try {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }) });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { ultimoQR = qr; conectado = false; }
      if (connection === "open") {
        conectado = true;
        ultimoQR = null;
        log.info("[VITALIS_WHATSAPP] Conectado ✅");
      }
      if (connection === "close") {
        conectado = false;
        iniciando = false;
        const debeReconectar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        log.warn(`[VITALIS_WHATSAPP] Conexión cerrada${debeReconectar ? " — reconectando..." : " — sesión cerrada, hay que escanear el QR de nuevo"}`);
        if (debeReconectar) setTimeout(iniciarWhatsapp, 3000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          if (m.key.fromMe || !m.message || m.key.remoteJid?.endsWith("@g.us")) continue;
          const numero = String(m.key.remoteJid || "").split("@")[0];
          const texto = m.message.conversation || m.message.extendedTextMessage?.text;
          if (!numero || !texto) continue;
          const respuesta = await procesarMensajeEntrante(numero, texto.trim(), m.pushName || "");
          if (respuesta) await sock.sendMessage(m.key.remoteJid, { text: respuesta });
        } catch (e) {
          log.error("[VITALIS_WHATSAPP] procesando mensaje:", e.message);
        }
      }
    });
  } catch (e) {
    iniciando = false;
    log.error("[VITALIS_WHATSAPP] No se pudo iniciar:", e.message);
  }
}

function normalizarNumero(numero) {
  let n = String(numero || "").replace(/\D/g, "");
  if (n.length === 8) n = "591" + n;
  return n;
}

async function enviarTexto(numero, texto) {
  if (!sock || !conectado) {
    log.warn("[VITALIS_WHATSAPP] No conectado — no se mandó el mensaje");
    return null;
  }
  return sock.sendMessage(`${normalizarNumero(numero)}@s.whatsapp.net`, { text: texto });
}

async function obtenerEstado() {
  const configurado = Boolean(CONFIG.SALUD_WHATSAPP_MEDICO_PHONE);
  if (conectado) return { configurado, conectado: true, qr: null };
  if (!ultimoQR) return { configurado, conectado: false, qr: null };
  return { configurado, conectado: false, qr: await QRCode.toDataURL(ultimoQR) };
}

// Para vincular un número distinto: cierra la sesión actual y pide un QR nuevo.
async function reiniciarSesion() {
  if (sock) { try { await sock.logout(); } catch (e) { /* seguimos igual */ } }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  conectado = false;
  ultimoQR = null;
  sock = null;
  iniciando = false;
  await iniciarWhatsapp();
}

module.exports = { iniciarWhatsapp, enviarTexto, obtenerEstado, reiniciarSesion };
