// ChatGo — IA Cerebro central
const { CONFIG, log } = require("../config");
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
    const minutos = (ahora - new Date(viaje.fechaAceptacion || ahora).getTime()) / 60000;
    const esperado = (viaje.distanciaKm || 5) * 4;
    if (minutos > esperado * 2.5 && minutos > 30) {
      alertas.push({ tipo: "tiempo_excesivo", desc: `${Math.round(minutos)} min (esperado ~${Math.round(esperado)} min)` });
      if (!viaje._demoraNofificada) {
        await enviarFn(viaje.usuarioPhone, `⚠️ Tu chofer está demorando más de lo esperado.\nEscribe *AYUDA* o *CANCELAR* si necesitás ayuda.`).catch(() => {});
        await Viaje.findByIdAndUpdate(viaje._id, { alertaSeguridad: true }).catch(() => {});
      }
    }
    if (alertas.length > 0) {
      await enviarFn(CONFIG.ADMIN_PHONE,
        `🚨 Alerta viaje ${String(viaje._id).slice(-6).toUpperCase()}\n` +
        `Chofer: ${viaje.choferNombre} (+${viaje.choferPhone})\n` +
        alertas.map(a => `⚠️ ${a.desc}`).join("\n")
      ).catch(() => {});
    }
    return alertas;
  } catch (e) { log.error("[IA_SEG]", e.message); return []; }
}

module.exports = { seleccionarMejorChofer, registrarEventoChofer, calcularMultiplierSurge, aplicarSurge, textoSurge, registrarViajeEnDemanda, enviarAlertasChoferes, monitorearViajeEnCurso, monitorearSeguridad, procesarReactivaciones, actualizarUltimoViaje };
