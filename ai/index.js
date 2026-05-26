const { verificarTraficoEnRuta } = require("../services/google");
const { AlertaSeg } = require("../db/models");
// ChatGo — IA Cerebro central
const { CONFIG, log } = require("../config");
const os = require("os");
const { Chofer, Viaje, ListaEspera, Usuario, CodigoPromo } = require("../db/models");
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
async function calcularMultiplierSurge() {
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
  } catch { return { multiplier: 1.0, motivos: [] }; }
}
function aplicarSurge(precio, m) { return m <= 1.0 ? precio : Math.ceil(precio * m); }
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
async function enviarAlertasChoferes() { }
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
async function procesarReactivaciones() { }
async function actualizarUltimoViaje(phone) {
  try { await Usuario.findOneAndUpdate({ phone }, { ultimoViajeAt: new Date() }); } catch { }
}

async function monitorearSeguridad(viaje, posChofer, posAnterior, enviarFn) {
  try {
    const alertas = [];
    const ahora = Date.now();
    
    // 1. TIEMPO EXCESIVO (lleva mucho más de lo esperado)
    const minutos = (ahora - new Date(viaje.fechaAceptacion || ahora).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4; // ~4 min por km en ciudad
    if (minutos > esperado * 2 && minutos > 25) {
      alertas.push({ tipo: "tiempo_excesivo", desc: `Lleva ${Math.round(minutos)} min (esperado ~${Math.round(esperado)} min)`, severidad: "media" });
    }
    
    // 2. CHOFER DETENIDO mucho tiempo sin estar en origen/destino
    if (posAnterior && posChofer && posAnterior.timestamp) {
      const dist = Math.sqrt(
        Math.pow(posChofer.lat - posAnterior.lat, 2) + Math.pow(posChofer.lng - posAnterior.lng, 2)
      ) * 111000;
      const minDetenido = (ahora - posAnterior.timestamp) / 60000;
      const enOrigen = viaje.origen?.lat && Math.abs(posChofer.lat - viaje.origen.lat) < 0.001;
      const enDestino = viaje.destino?.lat && Math.abs(posChofer.lat - viaje.destino.lat) < 0.001;
      if (dist < 50 && minDetenido > 7 && !enOrigen && !enDestino) {
        alertas.push({ tipo: "parada_sospechosa", desc: `Detenido ${Math.round(minDetenido)} min sin estar en origen/destino`, severidad: "alta" });
      }
    }
    
    // 3. TRÁFICO/BLOQUEO REAL (Google Distance Matrix)
    if (posChofer && viaje.destino?.lat && viaje.estado === "en_curso") {
      const trafico = await verificarTraficoEnRuta(posChofer, viaje.destino);
      if (trafico && (trafico.severidad === "trafico_pesado" || trafico.severidad === "bloqueo_grave")) {
        const esBloqueo = trafico.severidad === "bloqueo_grave";
        alertas.push({
          tipo: esBloqueo ? "bloqueo" : "trafico",
          desc: `${esBloqueo ? "🚧 Bloqueo o trancadera detectada" : "🚦 Tráfico pesado"}: +${trafico.retrasoMin} min de retraso`,
          severidad: esBloqueo ? "alta" : "media",
          retrasoMin: trafico.retrasoMin,
        });
      }
    }
    
    // 4. NOTIFICACIONES
    for (const alerta of alertas) {
      // Guardar en base de datos para historial
      try {
        await AlertaSeg.create({
          viajeId: viaje._id,
          tipo: alerta.tipo,
          descripcion: alerta.desc,
          posicion: posChofer ? { lat: posChofer.lat, lng: posChofer.lng } : undefined,
        });
      } catch { }
      
      // Notificar al pasajero (solo si no fue notificado de esta misma alerta)
      const yaNotificado = await AlertaSeg.findOne({ 
        viajeId: viaje._id, tipo: alerta.tipo, notificadoPasajero: true 
      }).lean();
      
      if (!yaNotificado && enviarFn) {
        if (alerta.tipo === "trafico" || alerta.tipo === "bloqueo") {
          await enviarFn(viaje.usuarioPhone,
            `${alerta.tipo === "bloqueo" ? "🚧" : "🚦"} ${alerta.desc}

` +
            `Tu chofer está demorando por causas externas. Si necesitás cancelar sin penalización escribí *CANCELAR*.`
          ).catch(() => {});
          // Notificar al chofer también
          if (viaje.choferPhone) {
            await enviarFn(viaje.choferPhone,
              `${alerta.tipo === "bloqueo" ? "🚧" : "🚦"} El sistema detectó ${alerta.tipo === "bloqueo" ? "un bloqueo" : "tráfico pesado"} en tu ruta.
` +
              `Si hay desvío posible, tomalo. Avisá al pasajero del retraso.`
            ).catch(() => {});
          }
        } else if (alerta.tipo === "tiempo_excesivo") {
          await enviarFn(viaje.usuarioPhone,
            `⚠️ Tu chofer está demorando más de lo esperado.
` +
            `Si necesitás ayuda escribí *AYUDA* o *CANCELAR* para cancelar sin penalización.`
          ).catch(() => {});
        }
        await AlertaSeg.updateMany(
          { viajeId: viaje._id, tipo: alerta.tipo },
          { notificadoPasajero: true }
        ).catch(() => {});
      }
    }
    
    // 5. Alertar al admin si hay anomalías graves (parada sospechosa o bloqueo)
    const graves = alertas.filter(a => a.severidad === "alta");
    if (graves.length > 0) {
      const yaNotificadoAdmin = await AlertaSeg.findOne({ 
        viajeId: viaje._id, notificadoAdmin: true 
      }).lean();
      if (!yaNotificadoAdmin && enviarFn) {
        await enviarFn(CONFIG.ADMIN_PHONE,
          `🚨 *Alerta viaje ${String(viaje._id).slice(-6).toUpperCase()}*
` +
          `Chofer: ${viaje.choferNombre || "?"} (+${viaje.choferPhone || "?"})
` +
          `Pasajero: +${viaje.usuarioPhone}

` +
          graves.map(a => `⚠️ ${a.desc}`).join("
")
        ).catch(() => {});
        await AlertaSeg.updateMany(
          { viajeId: viaje._id },
          { notificadoAdmin: true }
        ).catch(() => {});
      }
    }
    
    return alertas;
  } catch (e) {
    log.error("[IA_SEG]", e.message);
    return [];
  }
}

module.exports = { seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad, procesarReactivaciones, actualizarUltimoViaje };
