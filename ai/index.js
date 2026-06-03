const { verificarTraficoEnRuta } = require("../services/google");
// ChatGo — IA Cerebro central
const { CONFIG, log } = require("../config");
const os = require("os");
const { Chofer, Viaje, ListaEspera, Usuario, CodigoPromo, Demanda, AlertaSeg } = require("../db/models");
const mongoose = require("mongoose");

// ─── IA INLINE (sin dependencias externas) ───────────────────────────────
function seleccionarMejorChofer(candidatos) {
  if (!candidatos.length) return null;
  return candidatos.reduce((a, b) => a.distanciaAlUsuario < b.distanciaAlUsuario ? a : b);
}
async function registrarEventoChofer(phone, tipo, datos = {}) {
  try {
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    await mongoose.connection.db.collection("eventoschofer").insertOne({
      choferPhone: phone, tipo, ...datos,
      hora: ahora.getHours(), diaSemana: ahora.getDay(), createdAt: new Date(),
    });
  } catch { }
}
async function calcularMultiplierSurge(lat, lng) {
  try {
    const libres = await Chofer.countDocuments({ estado: "libre" });
    const espera = await ListaEspera.countDocuments({});
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const hora = ahora.getHours(); const dia = ahora.getDay();
    let m = 1.0; let motivos = [];
    if (libres === 0) { m = 1.3; motivos.push("sin_choferes"); }
    else if (espera > libres * 2) { m = 1.2; motivos.push("alta_demanda"); }
    if ([17,18,19].includes(hora) && [1,2,3,4,5].includes(dia)) { m = Math.max(m, 1.15); motivos.push("hora_pico"); }
    if (dia === 5 && [17,18,19].includes(hora)) { m = Math.max(m, 1.25); motivos.push("viernes_tarde"); }
    return { multiplier: Math.min(1.5, m), motivos };
  } catch (e) { 
    log.error("[SURGE]", e.message);
    return { multiplier: 1.0, motivos: [] }; 
  }
}
function aplicarSurge(precioBase, multiplier) {
  if (!multiplier || multiplier <= 1) return precioBase;
  return Math.round(precioBase * multiplier);
}
function textoSurge(m, motivos) {
  if (m <= 1.0) return null;
  return `⚠️ _Precio ajustado +${Math.round((m-1)*100)}% por alta demanda._`;
}
async function registrarViajeEnDemanda(viaje) {
  try {
    if (!viaje.origen?.lat) return;
    const ahora = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
    const key = `${Math.round(viaje.origen.lat*200)/200}_${Math.round(viaje.origen.lng*200)/200}_${ahora.getHours()}_${ahora.getDay()}`;
    await mongoose.connection.db.collection("demandas").findOneAndUpdate(
      { zonaKey: key },
      { $inc: { totalViajes: 1 }, $set: { lat: viaje.origen.lat, lng: viaje.origen.lng, ultimaActualizacion: new Date() } },
      { upsert: true }
    );
  } catch { }
}
async function enviarAlertasChoferes(enviarMensajeFn) {
  try {
    if (!enviarMensajeFn) return;
    const ahora = new Date();
    const hora = ahora.getHours();
    const diaSemana = ahora.getDay();
    
    // Buscar zonas calientes en esta hora/día
    const zonasCalientes = await Demanda.find({ 
      hora, diaSemana, cantidad: { $gte: 3 } 
    }).sort({ cantidad: -1 }).limit(3).lean();
    
    if (zonasCalientes.length === 0) return;
    
    // Choferes libres en el sistema
    const libres = await Chofer.find({ estado: "libre" }).limit(50).lean();
    if (libres.length === 0) return;
    
    const zonasTexto = zonasCalientes.map(z => `📍 *${z.zona}* (${z.cantidad} viajes en esta hora)`).join("\n");
    const msg = `🔥 *Zonas con alta demanda ahora*

${zonasTexto}

Movete cerca de estas zonas para conseguir viajes más rápido.`;
    
    for (const chofer of libres) {
      // Solo enviar cada 2 horas máximo por chofer
      const ultimaAlerta = chofer.ultimaAlertaZona ? new Date(chofer.ultimaAlertaZona).getTime() : 0;
      if (Date.now() - ultimaAlerta < 2 * 60 * 60 * 1000) continue;
      
      await enviarMensajeFn(chofer.phone, msg).catch(() => {});
      await Chofer.findByIdAndUpdate(chofer._id, { ultimaAlertaZona: new Date() }).catch(() => {});
    }
    
    log.info(`[IA_ALERTAS] Notificados ${libres.length} choferes sobre ${zonasCalientes.length} zonas calientes`);
  } catch (e) {
    log.error("[IA_ALERTAS_CH]", e.message);
  }
}
async function monitorearViajeEnCurso(viaje, posChofer, enviarFn) {
  try {
    const min = (Date.now() - new Date(viaje.fechaAceptacion).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4;
    if (min > esperado * 2.5 && min > 30) {
      await enviarFn(CONFIG.ADMIN_PHONE, `⚠️ Viaje ${viaje._id} lleva ${Math.round(min)} min (esperado ~${Math.round(esperado)} min)
Chofer: ${viaje.choferNombre}`).catch(() => {});
    }
  } catch { }
  return [];
}
async function procesarReactivaciones(enviarMensajeFn) {
  try {
    if (!enviarMensajeFn) return;
    const hace15dias = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    
    // Usuarios que tuvieron al menos 1 viaje pero no han vuelto en 15+ días
    const inactivos = await Usuario.find({
      ultimoViajeAt: { $lt: hace15dias, $ne: null },
      promoReactivacionEnviada: { $ne: true },
      aceptoTerminos: true,
    }).limit(30).lean();
    
    if (inactivos.length === 0) return;
    
    for (const usr of inactivos) {
      try {
        // Generar código de descuento 30% que dura 7 días
        const codigo = `VUELVE${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const venceEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        
        await CodigoPromo.create({
          codigo, descuento: 30, usuario: usr.phone, 
          venceEn, usado: false,
        });
        
        const nombre = usr.nombre || "amigo";
        const msg = `👋 Hola ${nombre}, te extrañamos en ChatGo!

🎁 Te regalamos un *30% de descuento* en tu próximo viaje.
Código: *${codigo}*
Válido por 7 días.

Pedí tu taxi cuando quieras y usá el código al confirmar el viaje.`;
        
        await enviarMensajeFn(usr.phone, msg).catch(() => {});
        await Usuario.findByIdAndUpdate(usr._id, { promoReactivacionEnviada: true }).catch(() => {});
      } catch (e) {
        log.warn("[REACTIV_USR]", usr.phone, e.message);
      }
    }
    
    log.info(`[IA_REACTIVACION] Procesados ${inactivos.length} usuarios inactivos`);
  } catch (e) {
    log.error("[IA_REACTIV]", e.message);
  }
}
async function actualizarUltimoViaje(phone) {
  try { 
    await Usuario.findOneAndUpdate(
      { phone }, 
      { ultimoViajeAt: new Date(), promoReactivacionEnviada: false }
    ); 
  } catch (e) {
    log.warn("[ACTUALIZAR_ULTIMO]", e.message);
  }
}

async function monitorearSeguridad(viaje, posChofer, posAnterior, enviarFn) {
  try {
    const alertas = [];
    const ahora = Date.now();

    const minutos = (ahora - new Date(viaje.fechaAceptacion || ahora).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4;
    if (minutos > esperado * 2 && minutos > 25) {
      alertas.push({ tipo: "tiempo_excesivo", desc: `Lleva ${Math.round(minutos)} min (esperado ~${Math.round(esperado)} min)`, severidad: "media" });
    }

    if (posAnterior && posChofer && posAnterior.timestamp) {
      const dist = Math.sqrt(Math.pow(posChofer.lat - posAnterior.lat, 2) + Math.pow(posChofer.lng - posAnterior.lng, 2)) * 111000;
      const minDetenido = (ahora - posAnterior.timestamp) / 60000;
      const enOrigen = viaje.origen && viaje.origen.lat && Math.abs(posChofer.lat - viaje.origen.lat) < 0.001;
      const enDestino = viaje.destino && viaje.destino.lat && Math.abs(posChofer.lat - viaje.destino.lat) < 0.001;
      if (dist < 50 && minDetenido > 7 && !enOrigen && !enDestino) {
        alertas.push({ tipo: "parada_sospechosa", desc: `Detenido ${Math.round(minDetenido)} min sin estar en origen/destino`, severidad: "alta" });
      }
    }

    if (posChofer && viaje.destino && viaje.destino.lat && viaje.estado === "en_curso") {
      const trafico = await verificarTraficoEnRuta(posChofer, viaje.destino);
      if (trafico && (trafico.severidad === "trafico_pesado" || trafico.severidad === "bloqueo_grave")) {
        const esBloqueo = trafico.severidad === "bloqueo_grave";
        alertas.push({
          tipo: esBloqueo ? "bloqueo" : "trafico",
          desc: `${esBloqueo ? "Bloqueo o trancadera detectada" : "Trafico pesado"}: +${trafico.retrasoMin} min de retraso`,
          severidad: esBloqueo ? "alta" : "media",
          retrasoMin: trafico.retrasoMin,
        });
      }
    }

    for (const alerta of alertas) {
      try {
        await AlertaSeg.create({
          viajeId: viaje._id,
          tipo: alerta.tipo,
          descripcion: alerta.desc,
          posicion: posChofer ? { lat: posChofer.lat, lng: posChofer.lng } : undefined,
        });
      } catch (_e) {}

      const yaNotificado = await AlertaSeg.findOne({ viajeId: viaje._id, tipo: alerta.tipo, notificadoPasajero: true }).lean();

      if (!yaNotificado && enviarFn) {
        if (alerta.tipo === "trafico" || alerta.tipo === "bloqueo") {
          const ico = alerta.tipo === "bloqueo" ? "🚧" : "🚦";
          const msgPas = `${ico} ${alerta.desc}

Tu chofer está demorando por causas externas. Si necesitás cancelar sin penalización escribí *CANCELAR*.`;
          await enviarFn(viaje.usuarioPhone, msgPas).catch(() => {});
          if (viaje.choferPhone) {
            const accion = alerta.tipo === "bloqueo" ? "un bloqueo" : "tráfico pesado";
            const msgCh = `${ico} El sistema detectó ${accion} en tu ruta.
Si hay desvío posible, tomalo. Avisá al pasajero del retraso.`;
            await enviarFn(viaje.choferPhone, msgCh).catch(() => {});
          }
        } else if (alerta.tipo === "tiempo_excesivo") {
          const msgT = `⚠️ Tu chofer está demorando más de lo esperado.
Si necesitás ayuda escribí *AYUDA* o *CANCELAR* para cancelar sin penalización.`;
          await enviarFn(viaje.usuarioPhone, msgT).catch(() => {});
        }
        await AlertaSeg.updateMany({ viajeId: viaje._id, tipo: alerta.tipo }, { notificadoPasajero: true }).catch(() => {});
      }
    }

    const graves = alertas.filter(a => a.severidad === "alta");
    if (graves.length > 0) {
      const yaNotificadoAdmin = await AlertaSeg.findOne({ viajeId: viaje._id, notificadoAdmin: true }).lean();
      if (!yaNotificadoAdmin && enviarFn) {
        const linea = graves.map(a => `⚠️ ${a.desc}`).join("\n");
        const msgAdmin = `🚨 *Alerta viaje ${String(viaje._id).slice(-6).toUpperCase()}*
Chofer: ${viaje.choferNombre || "?"} (+${viaje.choferPhone || "?"})
Pasajero: +${viaje.usuarioPhone}

${linea}`;
        await enviarFn(CONFIG.ADMIN_PHONE, msgAdmin).catch(() => {});
        await AlertaSeg.updateMany({ viajeId: viaje._id }, { notificadoAdmin: true }).catch(() => {});
      }
    }

    return alertas;
  } catch (e) {
    log.error("[IA_SEG]", e.message);
    return [];
  }
}

module.exports = { seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad, procesarReactivaciones, actualizarUltimoViaje };
