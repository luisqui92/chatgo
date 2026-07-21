// services/push.js — Web Push real (funciona con el navegador cerrado)
// Usa VAPID + Service Worker. Si web-push no está instalado o faltan las
// llaves VAPID, todo queda desactivado silenciosamente (no rompe el arranque).
const { log } = require("../config");
const prisma = require("../db/prisma");

let webpush = null;
let ACTIVO = false;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:soporte@chatgo.ia.bo";

try {
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush = require("web-push");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    ACTIVO = true;
    log.info("🔔 Web Push activo (VAPID configurado)");
  } else {
    log.warn("🔕 Web Push desactivado: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
  }
} catch (e) {
  log.warn("🔕 Web Push desactivado: paquete web-push no instalado (" + e.message + ")");
}

function pushActivo() {
  return ACTIVO;
}

function clavePublica() {
  return VAPID_PUBLIC;
}

// Guarda la suscripción del navegador para ese teléfono
async function guardarSuscripcion(phone, subscription) {
  if (!phone || !subscription) return false;
  try {
    await prisma.usuario.upsert({
      where: { phone },
      update: { pushWeb: subscription },
      create: { phone, pushWeb: subscription },
    });
    return true;
  } catch (e) {
    log.warn("push: no se pudo guardar suscripción de " + phone + ": " + e.message);
    return false;
  }
}

// Borra la suscripción (al terminar el viaje o si quedó inválida)
async function borrarSuscripcion(phone) {
  try {
    await prisma.usuario.update({
      where: { phone },
      data: { pushWeb: null },
    });
  } catch (_) {}
}

// Envía una notificación push al celular del pasajero.
// Devuelve true si se envió, false si no hay suscripción / push inactivo.
async function enviarPushWeb(phone, titulo, cuerpo, url) {
  if (!ACTIVO || !phone) return false;
  let sub = null;
  try {
    const u = await prisma.usuario.findUnique({
      where: { phone },
      select: { pushWeb: true },
    });
    sub = u && u.pushWeb;
  } catch (_) {
    return false;
  }
  if (!sub) {
    log.info(`[PUSH] ${phone}: sin suscripción guardada (el pasajero no activó las notificaciones) — "${titulo}"`);
    return false;
  }

  const payload = JSON.stringify({
    title: titulo || "ChatGo",
    body: cuerpo || "",
    url: url || "/pedir",
    icon: "/logo.png",
    badge: "/logo.png",
  });

  try {
    await webpush.sendNotification(sub, payload);
    log.info(`[PUSH] ✅ Enviado a ${phone}: "${titulo}"`);
    return true;
  } catch (e) {
    const code = e && e.statusCode;
    // 404/410 = suscripción vencida → la limpiamos
    if (code === 404 || code === 410) {
      await borrarSuscripcion(phone);
    } else {
      log.warn("push: error enviando a " + phone + ": " + (e && e.message));
    }
    return false;
  }
}

module.exports = {
  pushActivo,
  clavePublica,
  guardarSuscripcion,
  borrarSuscripcion,
  enviarPushWeb,
};
