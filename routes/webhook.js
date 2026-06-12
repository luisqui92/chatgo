// ChatGo — webhook.js
const mongoose = require("mongoose");
const { limitWebhook } = require("../services/ratelimit");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, ListaEspera, CodigoPromo, LocationReference } = require("../db/models");
const { getSession, checkRateLimit, sessionCache, yaProcesoMensaje } = require("../services/session");
const { enviarMensaje, enviarBotones, verificarFirmaMeta } = require("../services/whatsapp");
const { procesarMensajeUsuario } = require("../flows/pasajero");
const { procesarMensajeChofer } = require("../flows/chofer");
const { enPromoGratis, fechaStrBolivia, formatearFechaPromo, promoCodigosActiva } = require("../services/utils");


module.exports = function(app, { procesarMensajeUsuario, procesarMensajeChofer, Chofer, Viaje, getSession, sessionCache, yaProcesoMensaje }) {

app.post("/webhook", limitWebhook, async (req, res) => {
  if (!verificarFirmaMeta(req)) {
    log.warn("[WEBHOOK] Firma inválida, rechazado");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      try {
        // FIX BUG#9 — deduplicar por msg.id (WhatsApp puede entregar el mismo mensaje dos veces)
        if (msg.id && yaProcesoMensaje(msg.id)) {
          log.warn(`[WEBHOOK] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }

        const phone = msg.from;
        const buttonId = msg.interactive?.button_reply?.id || null;
        const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
        const mediaId = msg.image?.id || null;

        log.info(`[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}", Button: ${buttonId || "-"}`);

        const dentroLimite = await checkRateLimit(phone);
        if (!dentroLimite) { log.warn(`[WEBHOOK] Rate limit excedido para ${phone}`); continue; }

        // Admin approvals
        if (buttonId && (buttonId.startsWith("aprobar_pago_") || buttonId.startsWith("rechazar_pago_"))) {
          if (phone !== CONFIG.ADMIN_PHONE) {
            log.warn(`[SECURITY] ${phone} intentó aprobar pago sin ser admin`);
            await enviarMensaje(phone, "❌ No tienes permiso para esa acción.");
            continue;
          }
          const esAprobar = buttonId.startsWith("aprobar_pago_");
          const choferPhone = buttonId.replace(/^(aprobar|rechazar)_pago_/, "");
          if (esAprobar) {
            await Chofer.findOneAndUpdate(
              { phone: choferPhone },
              { "pagoDiario.aprobado": true, "pagoDiario.fecha": new Date(), "pagoDiario.fechaStr": fechaStrBolivia(), estado: "libre" }
            );
            await enviarBotones(choferPhone, `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
              { id: "chofer_ocupado", title: "🔴 Ocupado" },
              { id: "chofer_ayuda", title: "❓ Ayuda" },
            ]);
            await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
          } else {
            await Chofer.findOneAndUpdate({ phone: choferPhone }, { "pagoDiario.pagado": false, "pagoDiario.aprobado": false, estado: "offline" });
            await enviarMensaje(choferPhone, `❌ Tu comprobante de pago fue rechazado. Contacta al admin: +591 62741818`);
            await enviarMensaje(phone, `❌ Pago rechazado para +${choferPhone}`);
          }
          continue;
        }

        // FIX BUG#8 — routing chofer/pasajero mejorado
        const esChofer = await Chofer.exists({ phone });
        const session = await getSession(phone);

        // Un pasajero con sesión activa de viaje NO debe ser re-ruteado al flujo chofer
        // aunque esté registrado como chofer en la BD
        const sesionEsPasajero = session && session.step && !session.step.startsWith("chofer_") && session.step !== "eligiendo_rol";

        // Verificar también si hay un viaje activo como pasajero en DB
        // Esto cubre el caso donde la sesión está corrupta pero el viaje sigue activo
        const tieneViajeActivoPasajero = sesionEsPasajero ? false : !!(await Viaje.findOne({
          usuarioPhone: phone,
          estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] },
        }).lean());

        const esRegistroChofer =
          !sesionEsPasajero && !tieneViajeActivoPasajero && (
            textoUpper === "CHOFER" ||
            textoUpper === "SOY CHOFER" ||
            textoUpper === "CONDUCTOR" ||
            (session && session.step?.startsWith("chofer_"))
          );

        // Prioridad: si tiene viaje activo como pasajero → siempre pasajero
        // Si está registrado como chofer Y no tiene sesión de pasajero → chofer
        if (tieneViajeActivoPasajero || sesionEsPasajero) {
          await procesarMensajeUsuario(phone, msg, buttonId);
        } else if (esChofer || esRegistroChofer) {
          await procesarMensajeChofer(phone, msg.text?.body || "", buttonId, mediaId, msg);
        } else {
          await procesarMensajeUsuario(phone, msg, buttonId);
        }
      } catch (eInner) {
        log.error("[WEBHOOK_MSG]", eInner.message, eInner.stack);
      }
    }
  } catch (e) {
    log.error("[WEBHOOK]", e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════


// Endpoint para ver referencias de voz (debug/admin)


// Endpoint público para verificar estado de la promo


// ═══════════════════════════════════════════════════════════════════════════
// TRACKING EN TIEMPO REAL — página propia, expira al terminar el viaje
// ═══════════════════════════════════════════════════════════════════════════

// Diagnóstico de geocoding — para verificar qué coords devuelve Google Maps
// Aprobar chofer manualmente desde el navegador (sin necesidad del comprobante)


// Ver todos los choferes pendientes de aprobación


};
