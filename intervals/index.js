// ChatGo — index.js
const mongoose = require("mongoose");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera } = require("../db/models");
const { getSession, updateSession, deleteSession, removeListaEspera, sessionCache } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
function getTraccar() { return require("../services/traccar"); }
const { calcularTiempoConTrafico, distanciaEntrePuntos: distPuntos } = require("../services/google");
const { distanciaEntrePuntos } = require("../services/google");
const { registrarEventoChofer, registrarViajeEnDemanda, monitorearSeguridad, enviarAlertasChoferes, procesarReactivaciones, actualizarUltimoViaje } = require("../ai");
const { asignarChofer } = require("../flows/viaje");

function iniciarIntervals(deps) {
  const {
    enviarMensaje, enviarBotones, getSession, updateSession, deleteSession,
    sessionCache, distanciaEntrePuntos,
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
    const pendientes = await ListaEspera.find({
      timestamp: { $gt: new Date(Date.now() - 30 * 60 * 1000) }
    }).limit(50);

    for (const espera of pendientes) {
      try {
        // Si está siendo cancelada por el usuario, ignorar esta entrada
        if (espera.cancelando) continue;

        const segundos = (ahora.getTime() - new Date(espera.timestamp).getTime()) / 1000;

        if (espera.ofertaActivaTraccarId && espera.ofertaActivaHasta) {
          const expirada = new Date(espera.ofertaActivaHasta) < ahora;
          if (!expirada) continue;
          log.info(`[ESPERA] Oferta expirada para ${espera.userPhone}`);
          espera.ofertasRechazadas = [...(espera.ofertasRechazadas || []), espera.ofertaActivaTraccarId];
          espera.ofertaActivaTraccarId = null;
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

        const chofer = await getTraccar().buscarChoferDisponibleTraccar(
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
          espera.ofertaActivaTraccarId = chofer.traccarId;
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
        await getTraccar().liberarReservaChoferTraccar(viaje.choferTraccarId);
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
          await asignarChofer(viaje.usuarioPhone, session, [viaje.choferTraccarId]);
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
        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
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

          const choferColorGPS = await Chofer.findOne({ traccarId: viaje.choferTraccarId }).lean();
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
        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);

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

  
// ═══════════════════════════════════════════════════════════════════════════
// MONITOREO DE SEGURIDAD DEL VIAJE — cada 90 segundos
// ═══════════════════════════════════════════════════════════════════════════
const ultimasPosViaje = new Map(); // viajeId -> { lat, lng, timestamp }

setInterval(async () => {
  try {
    const enCurso = await Viaje.find({ estado: { $in: ["en_camino", "en_curso"] } }).limit(50);
    for (const viaje of enCurso) {
      try {
        if (!viaje.choferTraccarId) continue;
        const pos = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
        if (!pos) continue;
        
        const posAnterior = ultimasPosViaje.get(String(viaje._id));
        const posActual = { lat: pos.lat, lng: pos.lng, timestamp: Date.now() };
        
        await monitorearSeguridad(viaje, posActual, posAnterior, enviarMensaje);
        
        ultimasPosViaje.set(String(viaje._id), posActual);
      } catch (e) {
        log.warn("[MONITOREO_SEG]", e.message);
      }
    }
    
    // Limpiar posiciones de viajes ya terminados
    if (ultimasPosViaje.size > 100) {
      const activos = new Set(enCurso.map(v => String(v._id)));
      for (const id of ultimasPosViaje.keys()) {
        if (!activos.has(id)) ultimasPosViaje.delete(id);
      }
    }
  } catch (e) {
    log.error("[MONITOREO_SEG_INTERVAL]", e.message);
  }
}, 90 * 1000); // cada 90 segundos

// ═══════════════════════════════════════════════════════════════════════════
// MONITOREO DE TRÁFICO Y DESVÍO DE RUTA — cada 2 minutos
// ═══════════════════════════════════════════════════════════════════════════
const alertasTraficoEnviadas = new Set(); // viajeId_tipo → evitar spam

setInterval(async () => {
  try {
    const enCurso = await Viaje.find({
      estado: "en_curso",
      "destino.lat": { $exists: true },
      tiempoEstimadoMin: { $exists: true, $ne: null },
    }).limit(20).lean();

    for (const viaje of enCurso) {
      try {
        if (!viaje.choferTraccarId) continue;

        const posChofer = await getTraccar().obtenerUbicacionChofer(viaje.choferTraccarId);
        if (!posChofer || posChofer.minutos > 3) continue;

        // ─── A) TIMEOUT: ¿lleva más del doble del tiempo estimado? ───────
        const minutosEnViaje = viaje.fechaInicioViaje
          ? Math.round((Date.now() - new Date(viaje.fechaInicioViaje).getTime()) / 60000)
          : null;

        const limiteMinutos = viaje.tiempoEstimadoMin * 2;

        if (minutosEnViaje && minutosEnViaje > limiteMinutos) {
          const keyTimeout = `${viaje._id}_timeout`;
          if (!alertasTraficoEnviadas.has(keyTimeout)) {
            alertasTraficoEnviadas.add(keyTimeout);

            // Consultar tráfico actual desde posición del chofer al destino
            const traficoActual = await calcularTiempoConTrafico(
              posChofer.lat, posChofer.lng,
              viaje.destino.lat, viaje.destino.lng
            );

            const linkMonitoreo = "https://chatgo.ia.bo/rastreo.html?id=" + viaje._id + "&api=" + encodeURIComponent(CONFIG.APP_URL + "/track/" + viaje._id + "/pos");

            if (traficoActual?.hayTrafico) {
              // Hay tráfico real — avisar al chofer
              const linkAlternativo = "https://www.google.com/maps/dir/?api=1&origin=" + posChofer.lat + "," + posChofer.lng + "&destination=" + viaje.destino.lat + "," + viaje.destino.lng + "&travelmode=driving";
              await enviarMensaje(
                viaje.choferPhone,
                `🚦 *Aviso de tráfico*\n\nHay tráfico significativo en tu zona (factor x\${traficoActual.factorTrafico}).\n\nTiempo estimado restante: ~\${traficoActual.minutosConTrafico} min\n\n🗺️ Considera ruta alternativa:\n\${linkAlternativo}`
              );
              log.info(`[TRAFICO] Viaje \${viaje._id} — tráfico x\${traficoActual.factorTrafico}, avisando a chofer`);
            } else {
              // No hay tráfico pero igual se está tardando — posible desvío
              const distDestino = distPuntos(posChofer.lat, posChofer.lng, viaje.destino.lat, viaje.destino.lng);
              await enviarMensaje(
                CONFIG.ADMIN_PHONE,
                `🚨 *Posible desvío de ruta*\n\n👤 Chofer: \${viaje.choferNombre} (+\${viaje.choferPhone})\n🚗 Placa: \${viaje.choferPlaca}\n⏱️ Lleva \${minutosEnViaje} min (estimado: \${viaje.tiempoEstimadoMin} min)\n📍 A \${Math.round(distDestino * 1000)}m del destino\n\n🔍 Monitoreo: \${linkMonitoreo}`
              );
              log.warn(`[DESVIO] Viaje \${viaje._id} — \${minutosEnViaje}min / estimado \${viaje.tiempoEstimadoMin}min`);
            }
          }
        }

        // ─── B) DESVÍO GEOGRÁFICO: ¿está muy lejos de la línea origen-destino? ──
        // Calcular si el chofer se alejó más de 1km de la línea recta origen→destino
        if (viaje.origen?.lat && viaje.destino?.lat) {
          const distAlOrigen = distPuntos(posChofer.lat, posChofer.lng, viaje.origen.lat, viaje.origen.lng);
          const distAlDestino = distPuntos(posChofer.lat, posChofer.lng, viaje.destino.lat, viaje.destino.lng);
          const distOrigenDestino = distPuntos(viaje.origen.lat, viaje.origen.lng, viaje.destino.lat, viaje.destino.lng);

          // Si la suma de distancias es más del doble de la distancia directa → desvío
          const ratioDesvio = (distAlOrigen + distAlDestino) / (distOrigenDestino || 1);
          const keyDesvio = `\${viaje._id}_desvio_geo`;

          if (ratioDesvio > 2.5 && !alertasTraficoEnviadas.has(keyDesvio)) {
            alertasTraficoEnviadas.add(keyDesvio);
            const linkMonitoreo = "https://chatgo.ia.bo/rastreo.html?id=" + viaje._id + "&api=" + encodeURIComponent(CONFIG.APP_URL + "/track/" + viaje._id + "/pos");
            await enviarMensaje(
              CONFIG.ADMIN_PHONE,
              `🚨 *Desvío de ruta detectado*\n\n👤 Chofer: \${viaje.choferNombre} (+\${viaje.choferPhone})\n🚗 Placa: \${viaje.choferPlaca}\n📐 Ratio de desvío: x\${Math.round(ratioDesvio * 10) / 10}\n\n🔍 Monitoreo: \${linkMonitoreo}`
            );
            log.warn(`[DESVIO_GEO] Viaje \${viaje._id} — ratio \${ratioDesvio.toFixed(2)}`);
          }
        }

      } catch (e) {
        log.warn("[TRAFICO_DESVIO]", e.message);
      }
    }

    // Limpiar alertas de viajes terminados
    if (alertasTraficoEnviadas.size > 200) {
      alertasTraficoEnviadas.clear();
    }

  } catch (e) {
    log.error("[TRAFICO_INTERVAL]", e.message);
  }
}, 2 * 60 * 1000); // cada 2 minutos

  log.info("✅ Todos los intervals iniciados");
}

module.exports = { iniciarIntervals };
