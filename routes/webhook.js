// ChatGo — webhook.js
const { limitWebhook } = require("../services/ratelimit");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, ListaEspera, CodigoPromo, LocationReference } = require("../db/models");
const { getSession, updateSession, checkRateLimit, sessionCache, yaProcesoMensaje } = require("../services/session");
const { enviarMensaje, enviarBotones, verificarFirmaMeta, registrarNumeroEntrada } = require("../services/whatsapp");
const { procesarModulos } = require("../modules");
const { procesarVerificacionWeb } = require("./web");
const { procesarMensajeUsuario } = require("../flows/pasajero");
const { procesarMensajeChofer } = require("../flows/chofer");
const { enPromoGratis, fechaStrBolivia, formatearFechaPromo, promoCodigosActiva } = require("../services/utils");


module.exports = function(app, { procesarMensajeUsuario, procesarMensajeChofer, Chofer, Viaje, getSession, sessionCache, yaProcesoMensaje }) {

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", limitWebhook, async (req, res) => {
  if (!verificarFirmaMeta(req)) {
    log.warn("[WEBHOOK] Firma inválida, rechazado");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    // MULTI-NÚMERO: por cuál número de WhatsApp entró este mensaje.
    // Las respuestas al usuario salen por ese mismo número (latente hasta
    // que se agreguen números extra en Meta; hoy siempre es el número padre).
    const phoneNumberId = req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    for (const msg of messages) {
      try {
        // FIX BUG#9 — deduplicar por msg.id (WhatsApp puede entregar el mismo mensaje dos veces)
        if (msg.id && yaProcesoMensaje(msg.id)) {
          log.warn(`[WEBHOOK] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }

        const phone = msg.from;
        // El admin siempre se atiende por el número padre
        registrarNumeroEntrada(phone, phone === CONFIG.ADMIN_PHONE ? CONFIG.WHATSAPP_PHONE_ID : phoneNumberId);
        const buttonId = msg.interactive?.button_reply?.id || msg.button?.payload || null;
        const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
        // Imagen normal, o imagen enviada como archivo/documento (comprobantes de pago)
        const mediaId = msg.image?.id || (msg.document?.mime_type?.startsWith("image/") ? msg.document.id : null);

        log.info(`[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}", Button: ${buttonId || "-"}`);

        // Guardar nombre de perfil WhatsApp en sesión (viene en value.contacts, no en msg)
        const waContacts = req.body.entry?.[0]?.changes?.[0]?.value?.contacts;
        const waName = waContacts?.find(c => c.wa_id === phone)?.profile?.name;
        if (waName) await updateSession(phone, { waName });

        const dentroLimite = await checkRateLimit(phone);
        if (!dentroLimite) { log.warn(`[WEBHOOK] Rate limit excedido para ${phone}`); continue; }

        // VERIFICACIÓN WEB EN 1 TOQUE: "ChatGo-XXXXXX" enlaza el número con la
        // sesión de la página web. Se procesa antes que cualquier otro flujo.
        if (msg.text?.body && await procesarVerificacionWeb(phone, msg.text.body)) continue;

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
            try {
              await Chofer.update({
                where: { phone: choferPhone },
                data: { pagoDiarioAprobado: true, pagoDiarioFecha: new Date(), pagoDiarioFechaStr: fechaStrBolivia(), estado: "libre" },
              });
            } catch (eUpd) { /* chofer no encontrado — ignorar */ }
            await enviarBotones(choferPhone, `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`, [
              { id: "chofer_ocupado", title: "🔴 Ocupado" },
              { id: "chofer_ayuda", title: "❓ Ayuda" },
            ]);
            await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
          } else {
            try {
              await Chofer.update({
                where: { phone: choferPhone },
                data: { pagoDiarioPagado: false, pagoDiarioAprobado: false, estado: "offline" },
              });
            } catch (eUpd) { /* chofer no encontrado — ignorar */ }
            await enviarMensaje(choferPhone, `❌ Tu comprobante de pago fue rechazado. Contacta al admin: +591 62741818`);
            await enviarMensaje(phone, `❌ Pago rechazado para +${choferPhone}`);
          }
          continue;
        }

        // ROUTING chofer/pasajero
        const esChofer = !!(await Chofer.findUnique({ where: { phone } }));
        // Los CHOFERES siempre se atienden por el número padre: las órdenes de
        // trabajo, botones y chat les llegan de UN solo número, escriban donde escriban
        if (esChofer) registrarNumeroEntrada(phone, CONFIG.WHATSAPP_PHONE_ID);
        const session = await getSession(phone);

        // Si es chofer registrado, NUNCA lo tratamos como pasajero por sesión residual.
        // Solo va al flujo pasajero si tiene un viaje activo como pasajero en DB.
        const tieneViajeActivoPasajero = esChofer ? !!(await Viaje.findFirst({
          where: {
            usuarioPhone: phone,
            estado: { in: ["pendiente","en_camino","esperando_pasajero","en_curso"] },
          },
        })) : false;

        // Para no-choferes: sesión activa los mantiene en flujo pasajero
        const sesionEsPasajero = !esChofer && session && session.step &&
          !session.step.startsWith("chofer_") && session.step !== "eligiendo_rol";

        // OJO: varios steps de PASAJERO tienen prefijo "chofer_" por razones históricas
        // (ej: chofer_esperando_pasajero, chofer_en_camino = "el chofer va en camino al pasajero").
        // Esos NO son registro de chofer. El registro real solo se dispara por palabra clave
        // o por steps que de verdad pertenecen al flujo del conductor.
        const stepsRegistroChofer = ["chofer_esperando_comprobante", "chofer_registro", "chofer_credenciales", "chofer_esperando_codigo_flota"];
        const esRegistroChofer =
          !esChofer && (
            textoUpper === "CHOFER" ||
            textoUpper === "SOY CHOFER" ||
            textoUpper === "CONDUCTOR" ||
            buttonId === "chofer_tiene_codigo" ||
            buttonId === "chofer_sin_codigo" ||
            (session && stepsRegistroChofer.includes(session.step))
          );

        log.info(`[ROUTING] phone=${phone} esChofer=${!!esChofer} step=${session?.step || "null"} esRegistroChofer=${esRegistroChofer} tieneViajeActivoPasajero=${tieneViajeActivoPasajero}`);

        if (tieneViajeActivoPasajero) {
          await procesarMensajeUsuario(phone, msg, buttonId);
        } else if (esChofer || esRegistroChofer) {
          await procesarMensajeChofer(phone, msg.text?.body || "", buttonId, mediaId, msg);
        } else {
          // PLATAFORMA MODULAR: si hay módulos activos (MODULOS_ACTIVOS) y el
          // mensaje corresponde a uno (favor/delivery/school/etc.), lo toma el
          // módulo. Con la flag vacía (default) esto devuelve false sin costo
          // y todo sigue al flujo pasajero de siempre.
          const manejadoPorModulo = await procesarModulos(phone, msg, buttonId, session);
          if (!manejadoPorModulo) {
            await procesarMensajeUsuario(phone, msg, buttonId);
          }
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
