// ChatGo — Flow viaje
const mongoose = require("mongoose");
const os = require("os");
const { CONFIG, log, detectarCiudadPorCoords } = require("../config");
const { Usuario, Chofer, Viaje, SessionState, ListaEspera, CodigoPromo } = require("../db/models");
const { getSession, updateSession, deleteSession, addListaEspera, removeListaEspera, sessionCache } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { buscarChoferDisponibleTraccar, reservarChoferTraccar, liberarReservaChoferTraccar } = require("../services/traccar");
const { distanciaEntrePuntos, generarLinkRutaConParadas } = require("../services/google");
const { enviarAlertasChoferes, monitorearViajeEnCurso, procesarReactivaciones } = require("../ai");
const { choferPagoAlDia, consumirCodigoPromo, enPromoGratis, fechaStrBolivia } = require("../services/utils");





// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER — FIX BUG#1 (race condition promo) + FIX BUG#7 (recursión)
// ═══════════════════════════════════════════════════════════════════════════

async function asignarChofer(userPhone, session, excludeTraccarIds = [], intento = 0) {
  // Validar que origen y destino no sean el mismo punto
  if (session?.ubicaciones?.origen && session?.ubicaciones?.destino) {
    const o = session.ubicaciones.origen;
    const d = session.ubicaciones.destino;
    if (o.lat && d.lat && Math.abs(o.lat - d.lat) < 0.0001 && Math.abs(o.lng - d.lng) < 0.0001) {
      log.warn(`[ASIGNAR] Origen y destino son el mismo para ${userPhone}`);
      await enviarMensaje(userPhone, "⚠️ El origen y el destino son el mismo lugar. Volvé a indicar tu destino o escribí *CANCELAR* para empezar de nuevo.");
      return false;
    }
  }

  // FIX BUG#7 — límite de reintentos para evitar recursión infinita
  if (intento >= CONFIG.MAX_REINTENTOS_ASIGNAR) {
    log.warn(`[ASIGNAR] Máximo de reintentos alcanzado para ${userPhone}`);
    await updateSession(userPhone, { ...session, step: "sin_chofer" });
    await addListaEspera(userPhone, { ...session, step: "sin_chofer" });
    if (intento === CONFIG.MAX_REINTENTOS_ASIGNAR) {
      const tipoTexto = session.tipoVehiculoSolicitado === "moto" ? "moto" : session.tipoVehiculoSolicitado === "van" ? "van" : session.tipoVehiculoSolicitado === "auto" ? "auto" : "móvil";
      await enviarMensaje(userPhone, `⏳ Seguimos buscando tu ${tipoTexto}...\n\n_Escribe CANCELAR si quieres dejar de buscar._`);
    }
    return;
  }

  const tipoSolicitado = session.tipoVehiculoSolicitado || null;
  const chofer = await buscarChoferDisponibleTraccar(session.origen, excludeTraccarIds, tipoSolicitado);

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

  const ciudadViaje = detectarCiudadPorCoords(session.origen?.lat, session.origen?.lng) || session.ciudadUsuario || null;
  const viaje = await Viaje.create({
    usuarioPhone: userPhone,
    choferPhone: chofer.phone,
    choferTraccarId: chofer.traccarId,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa,
    ciudad: ciudadViaje,
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

  const reservado = await reservarChoferTraccar(chofer.traccarId, viaje._id);
  if (!reservado) {
    log.warn(`[ASIGNAR] Chofer ${chofer.nombre} ya fue reservado. Reintentando...`);
    await Viaje.findByIdAndDelete(viaje._id);
    // FIX BUG#7: pasar intento + 1 en lugar de recursión sin límite
    await asignarChofer(userPhone, session, [...excludeTraccarIds, chofer.traccarId], intento + 1);
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
    choferId: chofer.traccarId,
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
    if (viaje.choferTraccarId) {
      await Chofer.findOneAndUpdate(
        { traccarId: viaje.choferTraccarId },
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

  // Incrementar contador de viajes del usuario
  const usuarioActualizado = await Usuario.findOneAndUpdate(
    { phone: userPhone },
    { $inc: { viajesTotal: 1 } },
    { new: true }
  );

  await deleteSession(userPhone);

  // ─── TIP POST-VIAJE: invitar a guardar casa/trabajo ──────────────────────
  // Se muestra cuando el usuario lleva 3 viajes y NO tiene casa NI trabajo guardados
  const viajesTotal = usuarioActualizado?.viajesTotal || 0;
  const lf = usuarioActualizado?.lugaresFrecuentes || {};
  const sinCasaNiTrabajo = !lf.casa?.lat && !lf.trabajo?.lat;
  // Tip en viaje 3, y como respaldo también en el 7 (por si se perdió el primero)
  const mostrarTip = sinCasaNiTrabajo && (viajesTotal === 3 || viajesTotal === 7);

  if (rating >= 4) {
    if (mostrarTip) {
      await enviarBotones(
        userPhone,
        `🙏 ¡Gracias por tu calificación!\n\n` +
        `💡 *Tip ChatGo:*\n` +
        `¿Sabías que podés guardar tu *casa* y *trabajo*?\n` +
        `Después decí _"llévame a casa"_ 🎤 y te llevo directo sin escribir nada. 🚀`,
        [
          { id: "tip_guardar_casa", title: "🏠 Guardar mi casa" },
          { id: "tip_guardar_trabajo", title: "💼 Guardar trabajo" },
          { id: "tip_mas_tarde", title: "⏭️ Más tarde" },
        ]
      );
    } else {
      await enviarBotones(
        userPhone,
        `🙏 ¡Gracias por tu calificación!\n\n¿Necesitas otro taxi?`,
        [
          { id: "pedir_otro_taxi", title: "🚖 Pedir otro taxi" },
          { id: "no_por_ahora", title: "👍 No por ahora" },
        ]
      );
    }
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
