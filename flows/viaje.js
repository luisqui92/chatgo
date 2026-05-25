// ChatGo — Flow viaje
const mongoose = require("mongoose");
const os = require("os");
const { CONFIG, log } = require("../config");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera, CodigoPromo } = require("../db/models");
const { getSession, updateSession, deleteSession, addListaEspera, removeListaEspera, sessionCache } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { obtenerUbicacionChofer, buscarChoferDisponible, reservarChofer, liberarReservaChofer } = require("../services/wialon");
const { distanciaEntrePuntos, generarLinkRutaConParadas } = require("../services/google");
const { enviarAlertasChoferes, monitorearViajeEnCurso, procesarReactivaciones } = require("../ai");
const { choferPagoAlDia, consumirCodigoPromo, enPromoGratis, fechaStrBolivia } = require("../services/utils");


function enPromoGratis() {
  if (!CONFIG.PROMO_GRATIS_HASTA) return false;
  return fechaStrBolivia() <= CONFIG.PROMO_GRATIS_HASTA;
}

function choferPagoAlDia(chofer) {
  if (enPromoGratis()) return true;
  if (!chofer?.pagoDiario?.aprobado) return false;
  return chofer.pagoDiario.fechaStr === fechaStrBolivia();
}

// ═══════════════════════════════════════════════════════════════════════════
// LIMPIEZA DE SESIONES ABANDONADAS — cada 30 minutos
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

async function asignarChofer(userPhone, session, excludeWialonIds = [], intento = 0) {
  // FIX BUG#7 — límite de reintentos para evitar recursión infinita
  if (intento >= CONFIG.MAX_REINTENTOS_ASIGNAR) {
    log.warn(`[ASIGNAR] Máximo de reintentos alcanzado para ${userPhone}`);
    await updateSession(userPhone, { ...session, step: "sin_chofer" });
    await addListaEspera(userPhone, { ...session, step: "sin_chofer" });
    // Solo mandar mensaje si es el primer intento de buscar (intento 0 ya mandó mensaje)
    if (intento === CONFIG.MAX_REINTENTOS_ASIGNAR) {
      const tipoTexto = session.tipoVehiculoSolicitado === "moto" ? "moto" : session.tipoVehiculoSolicitado === "auto" ? "auto" : "móvil";
      await enviarMensaje(userPhone, `⏳ Seguimos buscando tu ${tipoTexto}...\n\n_Escribe CANCELAR si quieres dejar de buscar._`);
    }
    return;
  }

  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const chofer = await buscarChoferDisponible(session.origen, excludeWialonIds, tipoSolicitado);

  if (!chofer) {
    await updateSession(userPhone, { ...session, step: "sin_chofer" });
    await addListaEspera(userPhone, { ...session, step: "sin_chofer" });
    // Solo mandar el mensaje "buscando" si es el primer intento (intento === 0)
    // Los reintentos por timeout del chofer no mandan mensaje para no spamear
    if (intento === 0) {
      const tipoTexto = tipoSolicitado === "moto" ? "moto" : tipoSolicitado === "auto" ? "auto" : "móvil";
      await enviarMensaje(userPhone, `⏳ Buscando un ${tipoTexto} cercano para ti...\n\n_Escribe CANCELAR si quieres dejar de buscar._`);
    }
    return;
  }

  const viaje = await Viaje.create({
    usuarioPhone: userPhone,
    choferPhone: chofer.phone,
    choferWialonId: chofer.wialonId,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa,
    origen: session.origen,
    destino: session.destino,
    paradas: session.paradas || [],
    observaciones: session.observaciones || "",
    distanciaKm: session.distancia,
    precioBase: session.precioBase || session.precio,
    descuentoBs: session.descuentoBs || 0,
    codigoPromoUsado: session.codigoPromoUsado || null,
    precioTotal: session.precio,
    precioPorKm: session.precioPorKm,
    tipoVehiculo: chofer.tipoVehiculo || tipoSolicitado || "auto",
    estado: "pendiente",
    fechaAsignacion: new Date(),
  });

  const reservado = await reservarChofer(chofer.wialonId, viaje._id);
  if (!reservado) {
    log.warn(`[ASIGNAR] Chofer ${chofer.nombre} ya fue reservado. Reintentando...`);
    await Viaje.findByIdAndDelete(viaje._id);
    // FIX BUG#7: pasar intento + 1 en lugar de recursión sin límite
    await asignarChofer(userPhone, session, [...excludeWialonIds, chofer.wialonId], intento + 1);
    return;
  }

  // FIX BUG#1 — consumir código DESPUÉS de confirmar reserva exitosa
  if (session.codigoPromoDocId) {
    try {
      await consumirCodigoPromo(session.codigoPromoDocId, userPhone, viaje._id);
    } catch (e) {
      log.error("[PROMO] Error consumiendo código:", e.message);
    }
  }

  await updateSession(userPhone, {
    ...session,
    step: "esperando_chofer",
    choferId: chofer.wialonId,
    choferPhone: chofer.phone,
    viajeId: viaje._id.toString(),
  });

  const linkViaje = generarLinkRutaConParadas(session.origen, session.paradas || [], session.destino);

  let textoParadas = "";
  if (session.paradas && session.paradas.length > 0) {
    textoParadas = session.paradas.map((p, i) => `🚏 Parada ${i + 1}: ${p.nombre || "Ver mapa"}`).join("\n") + "\n";
  }

  const textoObs = session.observaciones ? `\n📝 *Notas del pasajero:*\n_${session.observaciones}_\n` : "";
  const textoDesc = session.descuentoBs > 0 ? `\n🎁 _Pasajero usó código de descuento (Bs ${session.descuentoBs} off)_\n` : "";

  await enviarBotones(
    chofer.phone,
    `🚖 *NUEVO VIAJE*\n\n` +
      `📏 Distancia viaje: ${session.distancia} km\n` +
      `💰 Precio a cobrar: Bs ${session.precio}\n` +
      textoDesc +
      `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
      `📍 Origen: ${session.origen.nombre || "Ver mapa"}\n` +
      textoParadas +
      `🏁 Destino: ${session.destino.nombre || "Ver mapa"}\n` +
      textoObs +
      `\n🗺️ Ruta del viaje:\n${linkViaje}\n\n` +
      `⏱️ Tienes *${CONFIG.TIMEOUT_ACEPTACION_CHOFER}s* para aceptar`,
    [
      { id: "aceptar_viaje", title: "✅ Aceptar" },
      { id: "rechazar_viaje", title: "❌ Rechazar" },
    ]
  );

  await enviarMensaje(
    userPhone,
    `🔍 Encontramos un chofer cerca.\n_Esperando confirmación (máx ${CONFIG.TIMEOUT_ACEPTACION_CHOFER}s)..._\n\n_Escribe CANCELAR si quieres cancelar._`
  );
}

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

// ═══════════════════════════════════════════════════════════════════════════
// CANCELACIÓN INICIADA POR PASAJERO — FIX BUG#2 (en_curso incluido)
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCancelacionPasajero(phone, session) {
  // Marcar atómicamente como cancelando ANTES de cualquier otra operación
  // Esto evita que el interval procese esta entrada mientras se cancela
  await ListaEspera.findOneAndUpdate(
    { userPhone: phone },
    { $set: { cancelando: true } }
  );

  // FIX BUG#2 — incluir "en_curso" y "buscando_otro_chofer" en el filtro
  const viaje = await Viaje.findOne({
    usuarioPhone: phone,
    estado: { $in: ["pendiente", "en_camino", "esperando_pasajero", "en_curso", "buscando_otro_chofer"] },
  });

  if (viaje) {
    await Viaje.findByIdAndUpdate(viaje._id, {
      estado: "cancelado_pasajero",
      cancelacionMotivo: "cancelado_por_pasajero",
      fechaFin: new Date(),
    });
    if (viaje.choferWialonId) {
      await Chofer.findOneAndUpdate(
        { wialonId: viaje.choferWialonId },
        { estado: "libre", viajeReservado: null, reservadoHasta: null }
      );
      await enviarMensaje(viaje.choferPhone, `❌ El pasajero canceló el viaje. Ya estás LIBRE para recibir otros viajes.`);
    }
    await enviarMensaje(phone, `✅ Viaje cancelado. Escribe cuando necesites otro taxi. 🚖`);
  } else {
    await enviarMensaje(phone, `✅ Búsqueda cancelada. Escribe cuando necesites otro taxi. 🚖`);
  }

  await removeListaEspera(phone);
  await deleteSession(phone);
}

// ═══════════════════════════════════════════════════════════════════════════
// SOPORTE / AYUDA
// ═══════════════════════════════════════════════════════════════════════════

async function procesarPedidoAyuda(phone, esChofer = false) {
  const viaje = esChofer
    ? await Viaje.findOne({ choferPhone: phone, estado: { $in: ["en_camino","esperando_pasajero","en_curso"] } })
    : await Viaje.findOne({ usuarioPhone: phone, estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } });

  await enviarMensaje(phone, `🆘 *Soporte ChatGo*\n\nHemos notificado al administrador. Te contactarán pronto desde +591 62741818.`);

  const contexto = viaje
    ? `\n\n📋 *Contexto del viaje:*\n` +
      `👤 Pasajero: +${viaje.usuarioPhone}\n` +
      `🚖 Chofer: ${viaje.choferNombre} (+${viaje.choferPhone}) - ${viaje.choferPlaca}\n` +
      `📏 ${viaje.distanciaKm} km | 💰 Bs ${viaje.precioTotal}\n` +
      `📍 Estado: ${viaje.estado}`
    : "";

  await enviarMensaje(
    CONFIG.ADMIN_PHONE,
    `🆘 *Pedido de AYUDA*\n\nDe ${esChofer ? "CHOFER" : "PASAJERO"}: +${phone}${contexto}\n\nContáctalo cuanto antes.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RATING DEL VIAJE
// ═══════════════════════════════════════════════════════════════════════════

async function solicitarRating(userPhone, viajeId) {
  await Viaje.findByIdAndUpdate(viajeId, { ratingSolicitado: true });
  await updateSession(userPhone, { step: "esperando_rating", viajeIdRating: String(viajeId) });
  await enviarBotones(
    userPhone,
    `¿Cómo estuvo tu viaje? ⭐\n\nTu opinión nos ayuda a mejorar.`,
    [
      { id: "rating_5", title: "⭐⭐⭐⭐⭐ Excelente" },
      { id: "rating_3", title: "⭐⭐⭐ Regular" },
      { id: "rating_1", title: "⭐ Malo" },
    ]
  );
}

async function registrarRating(userPhone, rating, viajeId) {
  const viaje = await Viaje.findByIdAndUpdate(viajeId, { ratingPasajero: rating });
  if (!viaje) return;

  if (viaje.choferPhone) {
    const chofer = await Chofer.findOne({ phone: viaje.choferPhone });
    if (chofer) {
      const totalAnterior = (chofer.ratingPromedio || 0) * (chofer.ratingCantidad || 0);
      const nuevaCantidad = (chofer.ratingCantidad || 0) + 1;
      const nuevoPromedio = (totalAnterior + rating) / nuevaCantidad;
      await Chofer.findByIdAndUpdate(chofer._id, {
        ratingPromedio: Math.round(nuevoPromedio * 10) / 10,
        ratingCantidad: nuevaCantidad,
      });
    }
  }

  await deleteSession(userPhone);

  if (rating >= 4) {
    await enviarBotones(
      userPhone,
      `🙏 ¡Gracias por tu calificación!\n\n¿Necesitas otro taxi?`,
      [
        { id: "pedir_otro_taxi", title: "🚖 Pedir otro taxi" },
        { id: "no_por_ahora", title: "👍 No por ahora" },
      ]
    );
  } else {
    await enviarBotones(
      userPhone,
      `🙏 Gracias por tu calificación.\n\nSentimos que no haya sido la mejor experiencia.\n¿Necesitas otro taxi?`,
      [
        { id: "pedir_otro_taxi", title: "🚖 Pedir otro taxi" },
        { id: "contactar_soporte", title: "🆘 Hablar con soporte" },
      ]
    );
    await enviarMensaje(
      CONFIG.ADMIN_PHONE,
      `⚠️ *Rating bajo*\n\nPasajero: +${userPhone}\nChofer: ${viaje.choferNombre} (+${viaje.choferPhone})\nRating: ${rating}/5\nViaje: ${viaje._id}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL CHOFER
// ═══════════════════════════════════════════════════════════════════════════


module.exports = { enPromoGratis, choferPagoAlDia, asignarChofer, procesarCancelacionPasajero, procesarPedidoAyuda, solicitarRating, registrarRating };
