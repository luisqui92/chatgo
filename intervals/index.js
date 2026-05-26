// ChatGo — index.js
const mongoose = require("mongoose");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera } = require("../db/models");
const { getSession, updateSession, deleteSession, removeListaEspera, sessionCache } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { obtenerUbicacionChofer, buscarChoferDisponible, liberarReservaChofer } = require("../services/wialon");
const { distanciaEntrePuntos } = require("../services/google");
const { registrarEventoChofer, registrarViajeEnDemanda, monitorearSeguridad, enviarAlertasChoferes, procesarReactivaciones, actualizarUltimoViaje } = require("../ai");
const { asignarChofer } = require("../flows/viaje");

function iniciarIntervals(deps) {
  const {
    enviarMensaje, enviarBotones, getSession, updateSession, deleteSession,
    sessionCache, obtenerUbicacionChofer, distanciaEntrePuntos,
    monitorearSeguridad, asignarChofer,
    registrarViajeEnDemanda, actualizarUltimoViaje, registrarEventoChofer,
    Chofer, Viaje, ListaEspera, SessionState, Usuario, CONFIG, log
  } = deps;

// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  try {
    const stepsPedido = [
      "esperando_origen","esperando_destino","esperando_origen_con_destino",
      "eligiendo_historial","preguntando_opciones","calculando",
      "eligiendo_tipo_vehiculo","confirmando_moto_incompatible",
      "ofreciendo_codigo","esperando_codigo","esperando_parada","esperando_observacion",
      "confirmando_ubicaciones_voz","aprendiendo_origen_voz","aprendiendo_destino_voz",
      "esperando_nombre_usuario","esperando_rating"
    ];
    const limite = new Date(Date.now() - CONFIG.SESSION_PEDIDO_TIMEOUT_MS);
    const sesiones = await SessionState.find({
      "data.step": { $in: stepsPedido },
      "data.updatedAt": { $lt: limite.toISOString() },
    });
    for (const s of sesiones) {
      log.info(`[SESSION_CLEANUP] Limpiando sesión abandonada: ${s.phone} step=${s.data.step} updatedAt=${s.data.updatedAt}`);
      await SessionState.deleteOne({ phone: s.phone });
      sessionCache.delete(s.phone);
    }
    if (sesiones.length > 0) log.info(`[SESSION_CLEANUP] ${sesiones.length} sesiones abandonadas limpiadas`);
  } catch (e) {
    log.error("[SESSION_CLEANUP]", e.message);
  }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA (interval) — búsqueda activa desde el segundo 0
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const ahora = new Date();
    const pendientes = await ListaEspera.find({});

    for (const espera of pendientes) {
      try {
        // Si está siendo cancelada por el usuario, ignorar esta entrada
        if (espera.cancelando) continue;

        const segundos = (ahora.getTime() - new Date(espera.timestamp).getTime()) / 1000;

        if (espera.ofertaActivaWialonId && espera.ofertaActivaHasta) {
          const expirada = new Date(espera.ofertaActivaHasta) < ahora;
          if (!expirada) continue;
          log.info(`[ESPERA] Oferta expirada para ${espera.userPhone}`);
          espera.ofertasRechazadas = [...(espera.ofertasRechazadas || []), espera.ofertaActivaWialonId];
          espera.ofertaActivaWialonId = null;
          espera.ofertaActivaHasta = null;
          await espera.save();
        }

        if (segundos > CONFIG.ESPERA_TIMEOUT_TOTAL) {
          log.info(`[ESPERA] Timeout total para ${espera.userPhone}`);
          await removeListaEspera(espera.userPhone);
          await updateSession(espera.userPhone, { step: "inicio" });
          await enviarMensaje(
            espera.userPhone,
            `😔 No encontramos chofer disponible en los últimos ${Math.round(CONFIG.ESPERA_TIMEOUT_TOTAL / 60)} minutos.\n\nPor favor intenta de nuevo en un ratito. 🚖`
          );
          continue;
        }

        const chofer = await buscarChoferDisponible(
          { lat: espera.origen.lat, lng: espera.origen.lng },
          espera.ofertasRechazadas || [],
          espera.tipoVehiculoSolicitado || null
        );

        // Anti-spam: no mandar mensaje si ya se mandó uno en los últimos 90s
        const ahoraMs = Date.now();
        const msSinMensaje = espera.ultimoMensajeAt
          ? ahoraMs - new Date(espera.ultimoMensajeAt).getTime()
          : Infinity;
        const puedeMandarMensaje = msSinMensaje > 90000;

        if (chofer) {
          espera.ofertaActivaWialonId = chofer.wialonId;
          espera.ofertaActivaHasta = new Date(ahoraMs + CONFIG.ESPERA_OFERTA_VIGENCIA * 1000);

          if (puedeMandarMensaje) {
            espera.ultimoMensajeAt = new Date();
            await espera.save();
            const sesionActual1 = await getSession(espera.userPhone) || {};
            await updateSession(espera.userPhone, { ...sesionActual1, step: "sin_chofer" });
            await enviarBotones(
              espera.userPhone,
              `🚖 *¡Encontramos un chofer cerca tuyo!*\n\n` +
                `👤 ${chofer.nombre}\n` +
                `📌 A ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km de ti\n` +
                `📏 ${espera.distancia} km de viaje\n` +
                `💰 Bs ${espera.precio}\n\n` +
                `¿Lo asignamos? _(tienes ${CONFIG.ESPERA_OFERTA_VIGENCIA}s para decidir)_`,
              [
                { id: "confirmar_viaje_recordatorio", title: "✅ Sí, taxi" },
                { id: "cancelar_viaje", title: "❌ Ya no" },
              ]
            );
          } else {
            await espera.save();
            log.info(`[ESPERA] Anti-spam: chofer encontrado para ${espera.userPhone} pero mensaje reciente (${Math.round(msSinMensaje/1000)}s ago) — silencioso`);
          }
        } else {
          if (segundos > CONFIG.ESPERA_NOTIFICAR_SIN_CHOFER && !espera.notificado) {
            espera.notificado = true;
            espera.ultimoMensajeAt = new Date();
            await espera.save();
            const sesionActual2 = await getSession(espera.userPhone) || {};
            await updateSession(espera.userPhone, { ...sesionActual2, step: "sin_chofer" });
            await enviarMensaje(
              espera.userPhone,
              `😔 Por ahora no hay móviles disponibles cerca tuyo.\n\nSeguimos buscando — te avisaremos apenas aparezca uno. 🚖\n\n_Escribe CANCELAR para dejar de buscar._`
            );
          }
        }
      } catch (eInner) {
        log.error("[ESPERA_ITEM]", eInner.message);
      }
    }
  } catch (e) {
    log.error("[ESPERA_LOOP]", e.message);
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT DE ACEPTACIÓN DEL CHOFER (30s)
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    const limite = new Date(Date.now() - CONFIG.TIMEOUT_ACEPTACION_CHOFER * 1000);
    const pendientes = await Viaje.find({ estado: "pendiente", fechaAsignacion: { $lt: limite } });

    for (const viaje of pendientes) {
      try {
        log.warn(`[TIMEOUT] Viaje ${viaje._id} sin respuesta del chofer ${viaje.choferPhone}`);
        await liberarReservaChofer(viaje.choferWialonId);
        await Viaje.findByIdAndUpdate(viaje._id, { estado: "buscando_otro_chofer", cancelacionMotivo: "timeout_chofer" });
        await enviarMensaje(viaje.choferPhone, "⏰ Se te pasó el tiempo para aceptar el viaje. Pasamos al siguiente chofer.");
        const session = await getSession(viaje.usuarioPhone);
        if (session && session.step === "esperando_chofer") {
          if (!session.origen || !session.destino) {
            log.warn(`[TIMEOUT] Sesión de ${viaje.usuarioPhone} sin origen/destino — cancelando`);
            await updateSession(viaje.usuarioPhone, { step: "inicio" });
            await enviarMensaje(viaje.usuarioPhone, "⏳ Hubo un problema buscando chofer. Por favor intenta de nuevo.");
          } else {
            // Pequeño delay para que el mensaje de timeout llegue antes que el de nuevo chofer
          await enviarMensaje(viaje.usuarioPhone, "⏳ El chofer no respondió a tiempo. Buscando otro...");
          await new Promise(r => setTimeout(r, 1500));
          await asignarChofer(viaje.usuarioPhone, session, [viaje.choferWialonId]);
          }
        }
      } catch (eInner) {
        log.error("[TIMEOUT_ITEM]", eInner.message);
      }
    }

    // FIX BUG#4 — limpiar viajes zombie en estado buscando_otro_chofer más de 10 min
    const limiteZombie = new Date(Date.now() - 10 * 60 * 1000);
    await Viaje.updateMany(
      { estado: "buscando_otro_chofer", updatedAt: { $lt: limiteZombie } },
      { estado: "cancelado_timeout", cancelacionMotivo: "zombie_cleanup", fechaFin: new Date() }
    );
  } catch (e) {
    log.error("[TIMEOUT_LOOP]", e.message);
  }
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// IA INTERVALS
// ═══════════════════════════════════════════════════════════════════════════

// Alertas de zonas calientes a choferes — cada hora
setInterval(async () => {
  try {
    await enviarAlertasChoferes(enviarMensaje);
  } catch (e) { log.error("[IA_PREDICCION_INTERVAL]", e.message); }
}, 60 * 60 * 1000);

// Reactivación de usuarios inactivos — cada 24 horas
setInterval(async () => {
  try {
    await procesarReactivaciones(enviarMensaje);
  } catch (e) { log.error("[IA_REACTIVACION_INTERVAL]", e.message); }
}, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER — FIX BUG#1 (race condition promo) + FIX BUG#7 (recursión)
// ═══════════════════════════════════════════════════════════════════════════


  
// ═══════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE LLEGADA AL DESTINO
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try {
    // A) LLEGADA AL ORIGEN DEL PASAJERO (≤50m)
    const enCamino = await Viaje.find({ estado: "en_camino", llegadaOrigenNotificada: false });
    for (const viaje of enCamino) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);
        if (posChofer.minutos > 5) continue;
        const distOrigen = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.origen.lat, viaje.origen.lng);
        if (distOrigen <= 0.05) {
          const updated = await Viaje.findOneAndUpdate(
            { _id: viaje._id, llegadaOrigenNotificada: false },
            { $set: { llegadaOrigenNotificada: true, estado: "esperando_pasajero" } },
            { new: true }
          );
          if (!updated) continue;

          const session = await getSession(viaje.usuarioPhone);
          if (session) await updateSession(viaje.usuarioPhone, { ...session, step: "chofer_esperando_pasajero" });

          const tipoVeh = updated.tipoVehiculo || "auto";
          const emoji = tipoVeh === "moto" ? "🏍️" : "🚗";
          const label = tipoVeh === "moto" ? "moto" : "auto";

          const choferColorGPS = await Chofer.findOne({ wialonId: viaje.choferWialonId }).lean();
          const colorGPS = choferColorGPS?.colorVehiculo ? ` ${choferColorGPS.colorVehiculo}` : "";
          await enviarMensaje(
            viaje.usuarioPhone,
            `🚕 *¡Tu chofer llegó!*\n\n👤 ${viaje.choferNombre}\n${emoji} ${label}${colorGPS} · placa: ${viaje.choferPlaca}\n\nPor favor dirígete al vehículo. 🚖`
          );

          // FIX BUG#3 — el GPS detectó llegada, le enviamos botones nuevos al chofer
          // y NO esperamos que presione el botón "Llegué" que ya está obsoleto
          const usuarioLlegada = await Usuario.findOne({ phone: viaje.usuarioPhone }).lean();
          const nombrePasajeroLlegada = usuarioLlegada?.nombre ? `\n🙋 Pregunta por: *ChatGo para ${usuarioLlegada.nombre}*` : "";
          await enviarBotones(
            viaje.choferPhone,
            `📍 *Estás a 50m del pasajero*${nombrePasajeroLlegada}\n\nYa le avisamos que llegaste.\nCuando el pasajero suba presiona:`,
            [
              { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
              { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
            ]
          );
          log.info(`[LLEGADA_ORIGEN] Notificado viaje ${viaje._id}`);
        }
      } catch { /* ignorar fallo individual */ }
    }

    // B) LLEGADA AL DESTINO (≤150m) + MONITOREO DE SEGURIDAD
    const enCurso = await Viaje.find({ estado: "en_curso", llegadaNotificada: false });
    for (const viaje of enCurso) {
      try {
        const posChofer = await obtenerUbicacionChofer(viaje.choferWialonId);

        // IA SEGURIDAD: monitorear comportamiento sospechoso
        if (!viaje.alertaSeguridad) {
          monitorearViajeEnCurso(viaje, posChofer, enviarMensaje).catch(() => {});
        }

        const distDestino = distanciaEntrePuntos(posChofer.lat, posChofer.lng, viaje.destino.lat, viaje.destino.lng);
        if (distDestino < 0.15) {
          await Viaje.findByIdAndUpdate(viaje._id, { llegadaNotificada: true });
          await enviarBotones(viaje.choferPhone, "📍 Parece que llegaste al destino. ¿Finalizas el viaje?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]);
          await enviarMensaje(viaje.usuarioPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      } catch { /* ignorar fallo individual */ }
    }
  } catch (e) {
    log.error("[LLEGADA_LOOP]", e.message);
  }
}, 30000);

  log.info("✅ Todos los intervals iniciados");
}

module.exports = { iniciarIntervals };
