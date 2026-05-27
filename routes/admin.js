// ChatGo — admin.js
const mongoose = require("mongoose");
const { enviarBotones } = require("../services/whatsapp");
const { enPromoGratis, escapeHtml, fechaStrBolivia, promoCodigosActiva } = require("../services/utils");
const { limitLogin, limitAdmin } = require("../services/ratelimit");
const path = require("path");
const https = require("https");
const http = require("http");
const url = require("url");
const os = require("os");
const { getUsuarios, hashPassword, generarToken, verificarToken, requireAuth, tienePermiso } =  require("../services/auth");

const { CONFIG, log } = require("../config");
const { Chofer, CodigoPromo, ListaEspera, LocationReference, Usuario, Viaje, ViajeDemo } = require("../db/models");
const { obtenerUbicacionChofer, wialonLogin } = require("../services/wialon");
const { geocodificarDireccion } = require("../services/google");

// ─── HELPERS DE SEGURIDAD ────────────────────────────────────────────────────



module.exports = function(app, deps) {


// ─── LOGIN ───────────────────────────────────────────────────────────────────
app.post("/admin/login", limitLogin, (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    const usuarios = getUsuarios();
    const user = usuarios.find(u => u.usuario === usuario);
    if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });
    const hashInput = hashPassword(password);
    if (hashInput !== user.hashPass) return res.status(401).json({ error: "Credenciales incorrectas" });
    const token = generarToken(user.usuario, user.rol);
    log.info(`[AUTH] Login exitoso: ${usuario} (${user.rol})`);
    res.json({ token, usuario: user.usuario, rol: user.rol, nombre: user.nombre });
  } catch (e) {
    log.error("[AUTH] Login error:", e.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// ─── ENDPOINT PÚBLICO PARA DEMO ─────────────────────────────────────────────
// Devuelve lista de choferes con datos NO sensibles (sin teléfono completo)
// Usado por admin-demo.html para mostrar choferes reales con viajes simulados
app.get("/demo/choferes", async (req, res) => {
  // CORS explícito para el endpoint demo (acceso público)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  try {
    const choferes = await Chofer.find({ nombre: { $exists: true, $ne: null, $ne: "" } })
      .select("nombre placa tipoVehiculo viajesTotal ratingPromedio ratingCantidad zona phone")
      .limit(50)
      .lean();
    
    // Ofuscar teléfonos (últimos 4 dígitos)
    const ofuscados = choferes.map(c => ({
      nombre: c.nombre || "Sin nombre",
      placa: c.placa || "—",
      tipoVehiculo: c.tipoVehiculo || "auto",
      viajesTotal: c.viajesTotal || 0,
      rating: c.ratingPromedio ? Number(c.ratingPromedio).toFixed(1) : null,
      ratingCantidad: c.ratingCantidad || 0,
      zona: c.zona || null,
      phoneMask: c.phone ? "+591 *** ** " + String(c.phone).slice(-4) : null,
    }));
    
    res.json({ choferes: ofuscados, total: ofuscados.length });
  } catch (e) {
    log.error("[DEMO_CHOFERES]", e.message);
    res.status(500).json({ error: "Error obteniendo choferes" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA DEMO COMPARTIDO — ViajeDemo en MongoDB
// Mismo estado para todos los usuarios, reset a las 4 AM Bolivia
// ═══════════════════════════════════════════════════════════════════════════

const PUNTOS_DEMO = [
  { nombre: 'Plaza 14 de Septiembre', lat: -17.3935, lng: -66.1570 },
  { nombre: 'Cine Center (Av. Ramón Rivero)', lat: -17.3895, lng: -66.1665 },
  { nombre: 'Mall Plaza Las Américas', lat: -17.3754, lng: -66.1635 },
  { nombre: 'Av. América esq. Pando', lat: -17.3784, lng: -66.1583 },
  { nombre: 'Av. Heroínas y San Martín', lat: -17.3917, lng: -66.1532 },
  { nombre: 'Av. Ayacucho y Sucre', lat: -17.3952, lng: -66.1574 },
  { nombre: 'Av. Ballivián (El Prado)', lat: -17.3866, lng: -66.1599 },
  { nombre: 'Plaza Recoleta', lat: -17.3823, lng: -66.1547 },
  { nombre: 'Mercado La Cancha', lat: -17.4015, lng: -66.1612 },
  { nombre: 'Estadio Félix Capriles', lat: -17.3984, lng: -66.1742 },
  { nombre: 'Aeropuerto Wilstermann', lat: -17.4218, lng: -66.1786 },
  { nombre: 'Terminal de Buses', lat: -17.4042, lng: -66.1591 },
  { nombre: 'UMSS Campus Central', lat: -17.3942, lng: -66.1469 },
  { nombre: 'Hospital Viedma', lat: -17.3973, lng: -66.1551 },
  { nombre: 'Plaza Colón', lat: -17.3915, lng: -66.1572 },
  { nombre: 'Av. Blanco Galindo km 4', lat: -17.3823, lng: -66.2014 },
  { nombre: 'Av. Blanco Galindo km 6.5', lat: -17.3795, lng: -66.2356 },
  { nombre: 'Tupuraya (Av. Petrolera)', lat: -17.3637, lng: -66.1716 },
  { nombre: 'Sarco (Calle Lanza)', lat: -17.3654, lng: -66.1832 },
  { nombre: 'Queru Queru', lat: -17.3712, lng: -66.1503 },
  { nombre: 'Sacaba Plaza 6 de Agosto', lat: -17.3978, lng: -66.0379 },
  { nombre: 'Quillacollo Plaza Bolívar', lat: -17.3942, lng: -66.2784 },
  { nombre: 'Tiquipaya', lat: -17.3287, lng: -66.2103 },
  { nombre: 'IC Norte', lat: -17.3717, lng: -66.1592 },
  { nombre: 'Av. Coña Coña esq. 6 de Agosto', lat: -17.3853, lng: -66.1947 },
  { nombre: 'UPB', lat: -17.3645, lng: -66.1453 },
];

// Lista de pasajeros con formatos variados (más realista para WhatsApp)
const NOMBRES_PASAJEROS_DEMO = [
  'Luis', 'Carlos', 'Ana', 'Pedro', 'María', 'Sofi', 'Andre', 'Juancho',
  'Daniel Choque', 'Mónica Quispe', 'Roberto V.', 'Gabriela',
  'Don Carlos', 'Doña Rosa', 'Tía Elena', 'Marco A.',
  'Lucia M.', 'Fer', 'Pato', 'Vero',
  'Edwin', 'Ramiro', 'Jhonny', 'Patty',
  'Sra. Vargas', 'Sr. Mendoza', 'Dani', 'Vivi',
  'José Luis', 'Ana María', 'Carlos R.', 'Cristian',
  'Susana', 'Beto', 'Mario', 'Rocío',
  'El Profe', 'La Profe', 'Doc Pérez', 'Ing. Rojas',
  'Diego', 'Eduardo', 'Cami', 'Jorge L.',
];

function nombrePasajeroDemo() {
  return NOMBRES_PASAJEROS_DEMO[Math.floor(Math.random() * NOMBRES_PASAJEROS_DEMO.length)];
}

function diaIdActual() {
  const ahora = new Date(Date.now() - 4 * 3600 * 1000); // -4h para que cambie a las 4am
  return ahora.getFullYear() * 10000 + (ahora.getMonth() + 1) * 100 + ahora.getDate();
}

function factorHora(h) {
  const c = [0.2,0.1,0.1,0.1,0.2,0.4, 0.8,1.4,1.6,1.2,0.9,1.0, 1.5,1.4,1.0,0.9,1.0,1.3, 1.8,1.6,1.4,1.0,0.6,0.4];
  return c[h] || 1.0;
}

function distanciaKm(a, b) {
  const dx = (a.lat - b.lat) * 111;
  const dy = (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

function calcularPrecioDemo(distKm, tipoVehiculo) {
  const base = tipoVehiculo === 'moto' ? 5 : 7;
  const porKm = tipoVehiculo === 'moto' ? 2.5 : 3.5;
  return Math.max(Math.round(base + distKm * porKm), tipoVehiculo === 'moto' ? 6 : 8);
}

// ─── TICK INTERNO: genera/avanza viajes demo cada minuto ────────────────────
async function tickDemo() {
  try {
    const diaId = diaIdActual();
    const ahora = Date.now();
    
    // Si cambió el día, borrar todo lo del día anterior
    const ultimoViaje = await ViajeDemo.findOne().sort({ diaId: -1 }).lean();
    if (ultimoViaje && ultimoViaje.diaId !== diaId) {
      await ViajeDemo.deleteMany({ diaId: { $ne: diaId } });
      log.info(`[DEMO] Nuevo día ${diaId} — viajes anteriores eliminados`);
    }
    
    // Obtener choferes reales activos
    const choferes = await Chofer.find({ nombre: { $exists: true, $ne: null, $ne: "" } }).limit(50).lean();
    if (choferes.length === 0) return;
    
    // Si es la primera vez del día, generar histórico desde las 4 AM
    const cantHoy = await ViajeDemo.countDocuments({ diaId });
    if (cantHoy === 0) {
      const inicioDia = new Date();
      inicioDia.setHours(4, 0, 0, 0);
      if (inicioDia.getTime() > ahora) inicioDia.setDate(inicioDia.getDate() - 1);
      const inicioMs = inicioDia.getTime();
      
      // Generar 6 viajes/hora desde inicio hasta ahora
      const docsAGuardar = [];
      let simTime = inicioMs;
      const intervaloBase = 60 * 60 * 1000 / 6;
      while (simTime < ahora) {
        const h = new Date(simTime).getHours();
        const proxInter = intervaloBase / factorHora(h) * (0.5 + Math.random());
        simTime += proxInter;
        if (simTime >= ahora) break;
        const doc = generarViajeDemo(simTime, ahora, choferes, diaId);
        if (doc) docsAGuardar.push(doc);
      }
      if (docsAGuardar.length > 0) {
        await ViajeDemo.insertMany(docsAGuardar);
        log.info(`[DEMO] Día ${diaId} inicializado · ${docsAGuardar.length} viajes históricos`);
      }
      return;
    }
    
    // Avanzar viajes activos (cambiar estados según el tiempo)
    const activos = await ViajeDemo.find({ 
      diaId, 
      estado: { $in: ['pendiente','en_camino','esperando_pasajero','en_curso'] } 
    }).lean();
    
    for (const v of activos) {
      let nuevoEstado = v.estado;
      let posLat = v.choferPosLat, posLng = v.choferPosLng;
      
      if (v.estado === 'pendiente' && ahora >= v.tAceptado) {
        nuevoEstado = 'en_camino';
      } else if (v.estado === 'en_camino' && ahora >= v.tLlegoOrigen) {
        nuevoEstado = 'esperando_pasajero';
        posLat = v.origen.lat;
        posLng = v.origen.lng;
      } else if (v.estado === 'en_camino') {
        // Interpolar posición del chofer al origen
        const progreso = (ahora - v.tAceptado) / (v.tLlegoOrigen - v.tAceptado);
        posLat = v.choferPosLat + (v.origen.lat - v.choferPosLat) * progreso;
        posLng = v.choferPosLng + (v.origen.lng - v.choferPosLng) * progreso;
      } else if (v.estado === 'esperando_pasajero' && ahora >= v.tSubioPasajero) {
        nuevoEstado = 'en_curso';
      } else if (v.estado === 'en_curso' && ahora >= v.tCompletado) {
        nuevoEstado = 'completado';
      } else if (v.estado === 'en_curso') {
        // Interpolar posición del chofer al destino
        const progreso = (ahora - v.tSubioPasajero) / (v.tCompletado - v.tSubioPasajero);
        posLat = v.origen.lat + (v.destino.lat - v.origen.lat) * progreso;
        posLng = v.origen.lng + (v.destino.lng - v.origen.lng) * progreso;
      }
      
      const updates = { choferPosLat: posLat, choferPosLng: posLng };
      if (nuevoEstado !== v.estado) {
        updates.estado = nuevoEstado;
        if (nuevoEstado === 'completado') {
          updates.rating = Math.random() > 0.12 ? 4 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
        }
      }
      await ViajeDemo.updateOne({ _id: v._id }, updates);
    }
    
    // Crear nuevo viaje si la probabilidad lo indica
    const horaActual = new Date().getHours();
    const probTick = (10 / 60) * factorHora(horaActual); // ~10/hora ajustado por curva
    if (Math.random() < probTick) {
      const doc = generarViajeDemo(ahora, ahora, choferes, diaId);
      if (doc) {
        await ViajeDemo.create(doc);
        log.info(`[DEMO] Nuevo viaje · ${doc.usuarioNombre} → ${doc.destino.nombre}`);
      }
    }
  } catch (e) {
    log.error("[DEMO_TICK]", e.message);
  }
}

function generarViajeDemo(momentoCreacion, ahoraReal, choferes, diaId) {
  const oIdx = Math.floor(Math.random() * PUNTOS_DEMO.length);
  let dIdx = Math.floor(Math.random() * PUNTOS_DEMO.length);
  let intentos = 0;
  while (dIdx === oIdx && intentos < 10) { dIdx = Math.floor(Math.random() * PUNTOS_DEMO.length); intentos++; }
  const origen = PUNTOS_DEMO[oIdx];
  const destino = PUNTOS_DEMO[dIdx];
  const distKm = distanciaKm(origen, destino);
  if (distKm < 0.5) return null;
  
  // Filtrar choferes que NO estén offline en este momento
  const horaCreacion = new Date(momentoCreacion).getHours();
  const choferesDisponibles = choferes.filter((c, i) => {
    const seed = (i * 23 + horaCreacion * 41) % 100;
    const limite = (horaCreacion < 6) ? 60 : 30;
    return seed >= limite;
  });
  if (choferesDisponibles.length === 0) return null;
  const choferIdx = Math.floor(Math.random() * choferesDisponibles.length);
  const chofer = choferesDisponibles[choferIdx];
  
  const tInicio = momentoCreacion;
  const tAceptado = tInicio + 5000 + Math.random() * 20000;
  const tLlegoOrigen = tAceptado + (distKm / 4) * 30000;
  const tSubioPasajero = tLlegoOrigen + 30000 + Math.random() * 90000;
  const tCompletado = tSubioPasajero + (distKm / 25) * 3600 * 1000;
  
  const cancelado = Math.random() < 0.10;
  let estado, fin = null, rating = null;
  if (cancelado) {
    estado = 'cancelado_pasajero';
    fin = tInicio + 10000 + Math.random() * 50000;
  } else if (ahoraReal < tAceptado) estado = 'pendiente';
  else if (ahoraReal < tLlegoOrigen) estado = 'en_camino';
  else if (ahoraReal < tSubioPasajero) estado = 'esperando_pasajero';
  else if (ahoraReal < tCompletado) estado = 'en_curso';
  else {
    estado = 'completado';
    fin = tCompletado;
    rating = Math.random() > 0.12 ? 4 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
  }
  
  return {
    diaId,
    choferIdx,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa || "—",
    choferTipo: chofer.tipoVehiculo || "auto",
    usuarioNombre: nombrePasajeroDemo(),
    usuarioPhone: '5917' + (1000000 + Math.floor(Math.random() * 9000000)),
    origen: { nombre: origen.nombre, lat: origen.lat, lng: origen.lng },
    destino: { nombre: destino.nombre, lat: destino.lat, lng: destino.lng },
    distanciaKm: Math.round(distKm * 10) / 10,
    precioTotal: calcularPrecioDemo(distKm, chofer.tipoVehiculo || 'auto'),
    estado,
    rating,
    tInicio, tAceptado, tLlegoOrigen, tSubioPasajero, tCompletado,
    choferPosLat: origen.lat + (Math.random() - 0.5) * 0.01,
    choferPosLng: origen.lng + (Math.random() - 0.5) * 0.01,
  };
}

// ─── ENDPOINT: estado actual del demo ────────────────────────────────────────
app.get("/demo/estado", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const diaId = diaIdActual();
    const viajes = await ViajeDemo.find({ diaId }).sort({ tInicio: -1 }).limit(200).lean();
    const choferesReales = await Chofer.find({ nombre: { $exists: true, $ne: null, $ne: "" } }).limit(50).lean();
    
    // Calcular estados de choferes según viajes activos
    const ocupados = new Set();
    const posiciones = {};
    viajes.filter(v => ['en_camino','esperando_pasajero','en_curso'].includes(v.estado)).forEach(v => {
      if (v.choferNombre) {
        ocupados.add(v.choferNombre);
        posiciones[v.choferNombre] = { lat: v.choferPosLat, lng: v.choferPosLng };
      }
    });
    
    // Decidir qué choferes están OFFLINE — varía por hora del día
    // Cada chofer tiene un patrón pseudo-aleatorio: ciertos están offline en madrugada,
    // otros toda la mañana, otros descansan al mediodía, etc.
    const horaActual = new Date().getHours();
    function estaOffline(idx, hora) {
      // Patrón: rota CADA HORA (no por bloques de 3h)
      // Cada chofer tiene un ciclo distinto basado en su idx
      const seed = (idx * 23 + hora * 41) % 100;
      // Madrugada (0-5h): ~60% offline; resto ~30% offline
      const limite = (hora < 6) ? 60 : 30;
      return seed < limite;
    }
    
    const choferes = choferesReales.map((c, i) => {
      const offline = estaOffline(i, horaActual);
      let estado = "offline";
      if (!offline) {
        estado = ocupados.has(c.nombre) ? "ocupado" : "libre";
      }
      return {
        idx: i,
        nombre: c.nombre,
        placa: c.placa || "—",
        tipoVehiculo: c.tipoVehiculo || "auto",
        viajesTotal: c.viajesTotal || 0,
        rating: c.ratingPromedio ? Number(c.ratingPromedio).toFixed(1) : (4.5 + Math.random() * 0.5).toFixed(1),
        ratingCantidad: c.ratingCantidad || 0,
        zona: c.zona || null,
        phoneMask: c.phone ? "+591 *** ** " + String(c.phone).slice(-4) : null,
        estado,
        pos: posiciones[c.nombre] || null,
      };
    });
    
    res.json({ diaId, choferes, viajes, timestamp: Date.now() });
  } catch (e) {
    log.error("[DEMO_ESTADO]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── CRON INTERNO: tick cada 60 segundos ─────────────────────────────────────
setInterval(tickDemo, 60 * 1000);
// Primer tick a los 5 segundos del arranque
setTimeout(tickDemo, 5000);




app.get("/unidades", requireAuth(), async (req, res) => {
  try {
    const eid = await wialonLogin();
    const resp = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "core/search_items",
        params: JSON.stringify({
          spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
          force: 1, flags: 4294967295, from: 0, to: 0,
        }),
        sid: eid,
      },
      timeout: CONFIG.TIMEOUT_WIALON,
    });
    if (!resp.data.items) return res.json({ error: "No se encontraron unidades", raw: resp.data });
    const unidades = resp.data.items.map(u => ({
      id: u.id,
      nombre: u.nm,
      uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos ? { lat: u.pos.y, lng: u.pos.x, hace_min: Math.round((Date.now() / 1000 - (u.pos.t || 0)) / 60) } : null,
    }));
    res.json({ total: unidades.length, unidades });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/stats", requireAuth(), async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const [usuarios, choferes, choferesLibres, choferesPagados, viajesHoy, viajesActivos, ratingPromedio] = await Promise.all([
      Usuario.countDocuments(),
      Chofer.countDocuments(),
      Chofer.countDocuments({ estado: "libre" }),
      Chofer.countDocuments({ "pagoDiario.aprobado": true, "pagoDiario.fechaStr": hoyStr }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
      Viaje.countDocuments({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
    ]);
    res.json({ hoy: hoyStr, usuarios, choferes, choferesLibres, choferesPagadosHoy: choferesPagados, viajesUltimas24h: viajesHoy, viajesActivos, rating: ratingPromedio[0] ? { promedio: Math.round(ratingPromedio[0].avg * 10) / 10, cantidad: ratingPromedio[0].count } : null });
  } catch (e) { res.json({ error: e.message }); }
});

app.get("/admin/referencias-voz", requireAuth(), async (req, res) => {
  try {
    const refs = await LocationReference.find().sort({ contador: -1 }).limit(100).lean();
    res.json({ total: refs.length, referencias: refs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/promo", requireAuth(), (req, res) => {
  const activa = enPromoGratis();
  const hoy = fechaStrBolivia();
  res.json({
    promoActiva: activa,
    fechaHoy: hoy,
    fechaFin: CONFIG.PROMO_GRATIS_HASTA,
    fechaFinLegible: formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA),
    mensaje: activa
      ? `🎉 Promo gratis activa hasta el ${formatearFechaPromo(CONFIG.PROMO_GRATIS_HASTA)}.`
      : `💰 Promo terminada. Cobro normal de Bs 10/día activado.`,
  });
});

app.get("/admin/viaje/:id", requireAuth(), async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.id).lean();
    if (!viaje) { res.status(404).send("<h1>Viaje no encontrado</h1>"); return; }

    let posChofer = null, posError = null;
    if (viaje.choferWialonId) {
      try { const p = await obtenerUbicacionChofer(viaje.choferWialonId); posChofer = { lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch (e) { posError = e.message; }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viaje · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;}.header h1{font-size:16px;color:#00d97e;}.back{color:#58a6ff;text-decoration:none;font-size:13px;}.info{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;}.info-label{color:#8b949e;font-size:10px;text-transform:uppercase;}.info-value{font-size:14px;margin-top:2px;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-en_curso{background:#0d3d20;color:#3fb950;}.estado-completado{background:#0d3d20;color:#3fb950;}.estado-pendiente,.estado-esperando_pasajero{background:#3d2c0d;color:#d29922;}.estado-en_camino{background:#0d2c3d;color:#58a6ff;}.estado-cancelado,.estado-cancelado_pasajero,.estado-cancelado_chofer{background:#3d0d0d;color:#f85149;}#map{height:calc(100vh - 200px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}.leyenda div{margin:3px 0;}.mi{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:6px;vertical-align:middle;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body>
<div class="header"><a href="/admin" class="back">← Volver al panel</a><h1>🚖 Viaje #${String(viaje._id).slice(-6).toUpperCase()}</h1><button onclick="location.reload()" style="background:#1f6feb;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔄 Actualizar</button></div>
<div class="info">
  <div><div class="info-label">Estado</div><div class="info-value"><span class="estado estado-${viaje.estado}">${viaje.estado.toUpperCase()}</span></div></div>
  <div><div class="info-label">Pasajero</div><div class="info-value">+${escapeHtml(viaje.usuarioPhone||"—")}</div></div>
  <div><div class="info-label">Chofer</div><div class="info-value">${escapeHtml(viaje.choferNombre||"—")}<br><small style="color:#8b949e">${escapeHtml(viaje.choferPlaca||"")} · ${viaje.tipoVehiculo==="moto"?"🏍️ Moto":"🚗 Auto"}</small></div></div>
  <div><div class="info-label">Distancia</div><div class="info-value">${viaje.distanciaKm||"—"} km</div></div>
  <div><div class="info-label">Precio</div><div class="info-value">Bs ${viaje.precioTotal||"—"}${viaje.descuentoBs>0?' <small style="color:#3fb950">(-Bs '+viaje.descuentoBs+')</small>':""}</div></div>
  ${posChofer?`<div><div class="info-label">GPS Chofer</div><div class="info-value" style="color:${posChofer.hace_min<=5?"#3fb950":posChofer.hace_min<=15?"#d29922":"#f85149"}">📡 ${posChofer.hace_min} min</div></div>`:""}
  ${viaje.observaciones?`<div style="grid-column:span 2"><div class="info-label">📝 Observaciones</div><div class="info-value">${escapeHtml(viaje.observaciones)}</div></div>`:""}
</div>
<div id="map"></div>
<div class="leyenda">
  <div><span class="mi" style="background:#3fb950"></span>Origen</div>
  ${(viaje.paradas||[]).length>0?'<div><span class="mi" style="background:#d29922"></span>Paradas</div>':""}
  <div><span class="mi" style="background:#f85149"></span>Destino</div>
  ${posChofer?'<div><span class="mi" style="background:#58a6ff"></span>Chofer ahora</div>':""}
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const viaje=${JSON.stringify({origen:viaje.origen,paradas:viaje.paradas||[],destino:viaje.destino,posChofer,estado:viaje.estado})};
const puntos=[viaje.origen,...viaje.paradas,viaje.destino].filter(p=>p&&p.lat);
if(viaje.posChofer)puntos.push(viaje.posChofer);
const cLat=puntos.reduce((s,p)=>s+p.lat,0)/puntos.length;
const cLng=puntos.reduce((s,p)=>s+p.lng,0)/puntos.length;
const map=L.map('map').setView([cLat,cLng],14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function mkIcon(color,label){return L.divIcon({html:'<div style="background:'+color+';width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:14px;"><span style="transform:rotate(45deg)">'+label+'</span></div>',iconSize:[30,30],iconAnchor:[15,30],className:''});}
if(viaje.origen?.lat)L.marker([viaje.origen.lat,viaje.origen.lng],{icon:mkIcon('#3fb950','A')}).addTo(map).bindPopup('<b>📍 Origen</b><br>'+(viaje.origen.nombre||''));
viaje.paradas.forEach((p,i)=>L.marker([p.lat,p.lng],{icon:mkIcon('#d29922',String(i+1))}).addTo(map).bindPopup('<b>🚏 Parada '+(i+1)+'</b><br>'+(p.nombre||'')));
if(viaje.destino?.lat)L.marker([viaje.destino.lat,viaje.destino.lng],{icon:mkIcon('#f85149','B')}).addTo(map).bindPopup('<b>🏁 Destino</b><br>'+(viaje.destino.nombre||''));
if(viaje.posChofer){const ci=L.divIcon({html:'<div style="background:#58a6ff;width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:18px;">🚖</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});L.marker([viaje.posChofer.lat,viaje.posChofer.lng],{icon:ci}).addTo(map).bindPopup('<b>🚖 Chofer ahora</b><br>Hace '+viaje.posChofer.hace_min+' min');}
const ruta=[];if(viaje.origen?.lat)ruta.push([viaje.origen.lat,viaje.origen.lng]);viaje.paradas.forEach(p=>ruta.push([p.lat,p.lng]));if(viaje.destino?.lat)ruta.push([viaje.destino.lat,viaje.destino.lng]);
if(ruta.length>=2)L.polyline(ruta,{color:'#58a6ff',weight:4,opacity:.7,dashArray:'8,8'}).addTo(map);
if(viaje.posChofer){const np=viaje.estado==='en_curso'&&viaje.destino?.lat?[viaje.destino.lat,viaje.destino.lng]:viaje.origen?.lat?[viaje.origen.lat,viaje.origen.lng]:null;if(np)L.polyline([[viaje.posChofer.lat,viaje.posChofer.lng],np],{color:'#3fb950',weight:3,opacity:.8}).addTo(map);}
const g=L.featureGroup();puntos.forEach(p=>g.addLayer(L.marker([p.lat,p.lng])));if(puntos.length>1)map.fitBounds(g.getBounds(),{padding:[50,50]});
if(['pendiente','en_camino','esperando_pasajero','en_curso'].includes(viaje.estado))setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_VIAJE]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa", requireAuth(), async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const p = await obtenerUbicacionChofer(c.wialonId); return { phone: c.phone, nombre: c.nombre, placa: c.placa, tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado, wialonId: c.wialonId, lat: p.lat, lng: p.lng, hace_min: p.minutos }; }
      catch { return null; }
    }));
    const validos = choferesConPos.filter(Boolean);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapa Choferes · ChatGo</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,sans-serif;background:#0f1419;color:#e6e6e6;}.header{background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;}.header h1{font-size:16px;color:#00d97e;}.header a{color:#58a6ff;text-decoration:none;font-size:13px;}.stats{display:flex;gap:14px;font-size:12px;}.stats span{color:#8b949e;}#map{height:calc(100vh - 60px);width:100%;}.leyenda{position:absolute;bottom:10px;left:10px;background:rgba(22,27,34,.95);padding:10px;border-radius:8px;border:1px solid #30363d;font-size:12px;z-index:1000;}</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body><div class="header"><a href="/admin">← Panel</a><h1>🗺️ Mapa de choferes en vivo</h1><div class="stats"><span>🟢 Libres: ${validos.filter(c=>c.estado==="libre").length}</span><span>🟡 Ocupados: ${validos.filter(c=>c.estado==="ocupado").length}</span><span>🔴 Offline: ${validos.filter(c=>c.estado==="offline").length}</span></div></div>
<div id="map"></div>
<div class="leyenda"><div>🟢 Libre</div><div>🟡 Ocupado</div><div>🔴 Offline</div><div style="margin-top:6px;color:#8b949e;font-size:11px">Auto-refresh: 30s</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const choferes=${JSON.stringify(validos)};
let cLat=-17.39,cLng=-66.157;
if(choferes.length>0){cLat=choferes.reduce((s,c)=>s+c.lat,0)/choferes.length;cLng=choferes.reduce((s,c)=>s+c.lng,0)/choferes.length;}
const map=L.map('map').setView([cLat,cLng],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(map);
function colorE(e){return e==='libre'?'#3fb950':e==='ocupado'?'#d29922':'#f85149';}
function iconC(c){const color=colorE(c.estado);const em=c.tipoVehiculo==='moto'?'🏍️':'🚗';return L.divIcon({html:'<div style="background:'+color+';width:36px;height:36px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:16px;">'+em+'</div>',iconSize:[36,36],iconAnchor:[18,18],className:''});}
choferes.forEach(c=>L.marker([c.lat,c.lng],{icon:iconC(c)}).addTo(map).bindPopup('<b>'+(c.nombre||'Sin nombre')+'</b><br>Placa: '+(c.placa||'—')+'<br>'+(c.tipoVehiculo==='moto'?'🏍️ Moto':'🚗 Auto')+'<br>Estado: '+c.estado.toUpperCase()+'<br>GPS: hace '+c.hace_min+' min<br>Tel: +'+c.phone));
if(choferes.length>1){const g=L.featureGroup(choferes.map(c=>L.marker([c.lat,c.lng])));map.fitBounds(g.getBounds(),{padding:[50,50]});}
setTimeout(()=>location.reload(),30000);
</script></body></html>`);
  } catch (e) { log.error("[ADMIN_MAPA]", e.message); res.status(500).send("Error: " + e.message); }
});

app.get("/admin/mapa-data", requireAuth(), async (req, res) => {
  try {
    const choferes = await Chofer.find().lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      if (!c.wialonId) return null;
      try { const pos = await obtenerUbicacionChofer(c.wialonId); if (pos.minutos > 30) return null; return { phone: c.phone, nombre: c.nombre||"—", placa: c.placa||"—", tipoVehiculo: c.tipoVehiculo||"auto", estado: c.estado||"offline", wialonId: c.wialonId, lat: pos.lat, lng: pos.lng, hace_min: pos.minutos, ratingPromedio: c.ratingPromedio||0, viajesTotal: c.viajesTotal||0 }; }
      catch { return null; }
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).lean();
    res.json({ timestamp: new Date().toISOString(), choferes: choferesConPos.filter(Boolean), viajesActivos });
  } catch (e) { log.error("[MAPA_DATA]", e.message); res.status(500).json({ error: e.message }); }
});

app.get("/admin/data", requireAuth(), async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const ahora = Date.now();
    const choferes = await Chofer.find().sort({ updatedAt: -1 }).lean();
    const choferesConPos = await Promise.all(choferes.map(async c => {
      let pos = null, posError = null;
      if (c.wialonId) { try { const p = await obtenerUbicacionChofer(c.wialonId); pos = { lat: p.lat, lng: p.lng, hace_min: p.minutos, wialonOk: true }; } catch (e) { posError = e.message; } }
      const pagoAlDia = !!(c.pagoDiario?.aprobado && c.pagoDiario?.fechaStr === hoyStr);
      return { _id: c._id, phone: c.phone, nombre: c.nombre||"", placa: c.placa||"", tipoVehiculo: c.tipoVehiculo||"auto", wialonId: c.wialonId||"", estado: c.estado||"offline", viajesTotal: c.viajesTotal||0, ratingPromedio: c.ratingPromedio||0, ratingCantidad: c.ratingCantidad||0, pagoDiario: c.pagoDiario||{}, pagoAlDia, viajeReservado: c.viajeReservado, ultimaPos: pos, posError };
    }));
    const viajesActivos = await Viaje.find({ estado: { $in: ["pendiente","en_camino","esperando_pasajero","en_curso"] } }).sort({ createdAt: -1 }).lean();
    const viajesRecientes = await Viaje.find().sort({ createdAt: -1 }).limit(20).lean();
    const listaEspera = await ListaEspera.find().lean();
    const _results = await Promise.allSettled([
      Usuario.countDocuments(),
      Usuario.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ createdAt: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.countDocuments({ estado: "completado", fechaFin: { $gte: new Date(ahora - 24*3600*1000) } }),
      Viaje.aggregate([{ $match: { ratingPasajero: { $exists: true } } }, { $group: { _id: null, avg: { $avg: "$ratingPasajero" }, count: { $sum: 1 } } }]),
      CodigoPromo.countDocuments({ usado: false, fechaVencimiento: { $gt: new Date() } }),
      CodigoPromo.countDocuments({ usado: true }),
    ]);
    const [totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, ratingAgg, codigosActivos, codigosUsados] = _results.map(r => r.status === "fulfilled" ? r.value : 0);
    res.json({
      timestamp: new Date().toISOString(),
      hoy: hoyStr,
      stats: { totalUsuarios, usuariosNuevosHoy, viajes24h, viajesCompletados24h, rating: (ratingAgg && ratingAgg[0]) ? { promedio: Math.round(ratingAgg[0].avg * 10) / 10, cantidad: ratingAgg[0].count } : null, codigosActivos, codigosUsados, choferesTotal: choferes.length, choferesLibres: choferesConPos.filter(c=>c.estado==="libre").length, choferesOcupados: choferesConPos.filter(c=>c.estado==="ocupado").length, choferesOffline: choferesConPos.filter(c=>c.estado==="offline").length, choferesPagadosHoy: choferesConPos.filter(c=>c.pagoAlDia).length, choferesConGPSReciente: choferesConPos.filter(c=>c.ultimaPos&&c.ultimaPos.hace_min<=15).length, viajesActivos: viajesActivos.length, enListaEspera: listaEspera.length },
      choferes: choferesConPos, viajesActivos, viajesRecientes, listaEspera,
      promo: { viajesActiva: enPromoGratis(), viajesFin: CONFIG.PROMO_GRATIS_HASTA, codigosActiva: promoCodigosActiva(), codigosFin: CONFIG.PROMO_CODIGOS_HASTA },
    });
  } catch (e) { log.error("[ADMIN_DATA]", e.message, e.stack); res.status(500).json({ error: e.message }); }
});

app.get("/admin/aprobar-chofer/:phone", requireAuth(["superadmin","admin"]), async (req, res) => {
  try {
    const phone = req.params.phone;
    const chofer = await Chofer.findOne({ phone });
    if (!chofer) return res.json({ error: `Chofer +${phone} no encontrado` });

    await Chofer.findOneAndUpdate(
      { phone },
      {
        "pagoDiario.aprobado": true,
        "pagoDiario.pagado": true,
        "pagoDiario.fecha": new Date(),
        "pagoDiario.fechaStr": fechaStrBolivia(),
        estado: "libre",
        viajeReservado: null,
        reservadoHasta: null,
      }
    );

    // Notificar al chofer por WhatsApp
    await enviarBotones(
      phone,
      `✅ *¡Pago aprobado!*\n\n🟢 Ya estás LIBRE para recibir viajes.\n\n_Aprobado manualmente por el administrador._`,
      [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );

    res.json({
      ok: true,
      mensaje: `✅ Chofer ${escapeHtml(chofer.nombre)} (+${phone}) aprobado y notificado`,
      estado: "libre",
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/admin/pendientes-aprobacion", requireAuth(), async (req, res) => {
  try {
    const hoyStr = fechaStrBolivia();
    const pendientes = await Chofer.find({
      $or: [
        { "pagoDiario.pagado": true, "pagoDiario.aprobado": false },
        { estado: "offline", "pagoDiario.fechaStr": { $ne: hoyStr } },
      ]
    }).lean();

    res.json({
      total: pendientes.length,
      hoy: hoyStr,
      choferes: pendientes.map(c => ({
        nombre: c.nombre,
        phone: c.phone,
        placa: c.placa,
        estado: c.estado,
        pagoDiario: c.pagoDiario,
        linkAprobar: `https://chatgo-production.up.railway.app/admin/aprobar-chofer/${c.phone}`,
      })),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});


app.get("/admin/me", requireAuth(), (req, res) => {
  res.json({ usuario: req.adminUser.usuario, rol: req.adminUser.rol });
});

app.get("/admin/geocod", requireAuth(), async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ error: "Falta ?q=direccion" });
  try {
    const resultado = await geocodificarDireccion(q);
    if (!resultado) return res.json({ query: q, resultado: null, mensaje: "Sin resultados" });
    res.json({
      query: q,
      lat: resultado.lat,
      lng: resultado.lng,
      nombre: resultado.nombre,
      mapLink: `https://www.google.com/maps?q=${resultado.lat},${resultado.lng}`,
      routeLink: `https://www.google.com/maps/dir/?api=1&origin=${resultado.lat},${resultado.lng}&destination=${resultado.lat},${resultado.lng}&travelmode=driving`,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Diagnóstico de viaje — ver exactamente qué coords se usaron
app.get("/admin/viaje-coords/:viajeId", requireAuth(), async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();
    if (!viaje) return res.json({ error: "Viaje no encontrado" });
    const linkRuta = generarLinkRutaConParadas(viaje.origen, viaje.paradas || [], viaje.destino);
    res.json({
      viajeId: viaje._id,
      estado: viaje.estado,
      origen: {
        nombre: viaje.origen?.nombre,
        lat: viaje.origen?.lat,
        lng: viaje.origen?.lng,
        mapLink: `https://www.google.com/maps?q=${viaje.origen?.lat},${viaje.origen?.lng}`,
      },
      destino: {
        nombre: viaje.destino?.nombre,
        lat: viaje.destino?.lat,
        lng: viaje.destino?.lng,
        mapLink: `https://www.google.com/maps?q=${viaje.destino?.lat},${viaje.destino?.lng}`,
      },
      linkRutaChofer: linkRuta,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API de posición — consultada por chatgo.ia.bo cada 15s
app.get("/track/:viajeId/pos", async (req, res) => {
  // CORS para chatgo.ia.bo (página estática externa)
  res.setHeader("Access-Control-Allow-Origin", "https://chatgo.ia.bo");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();
    if (!viaje) return res.json({ error: "not_found" });

    const activo = ["en_camino","esperando_pasajero","en_curso"].includes(viaje.estado);
    if (!activo) {
      return res.json({ terminado: true, estado: viaje.estado, destino: viaje.destino });
    }

    const pos = await obtenerUbicacionChofer(viaje.choferWialonId);
    res.json({
      terminado: false,
      lat: pos.lat,
      lng: pos.lng,
      hace_min: pos.minutos,
      estado: viaje.estado,
      choferNombre: viaje.choferNombre,
      choferPlaca: viaje.choferPlaca,
      tipoVehiculo: viaje.tipoVehiculo || "auto",
      origen: viaje.origen,
      destino: viaje.destino,
      distanciaKm: viaje.distanciaKm,
      precioTotal: viaje.precioTotal,
    });
  } catch (e) {
    log.error("[TRACK_POS]", e.message);
    res.json({ error: e.message });
  }
});

// Página de rastreo HTML con Google Maps
app.get("/track/:viajeId", async (req, res) => {
  try {
    const viaje = await Viaje.findById(req.params.viajeId).lean();

    if (!viaje) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGo</title>
<style>body{font-family:sans-serif;background:#0f1419;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;flex-direction:column;gap:12px;}</style>
</head><body><div style="font-size:48px">🚖</div><h2>Link inválido</h2><p style="color:#8b949e">Este enlace de rastreo no existe.</p></body></html>`);
    }

    const activo = ["en_camino","esperando_pasajero","en_curso"].includes(viaje.estado);
    const emoji = viaje.tipoVehiculo === "moto" ? "🏍️" : "🚗";
    const label = viaje.tipoVehiculo === "moto" ? "Moto" : "Auto";
    const estadoTexto = viaje.estado === "esperando_pasajero"
      ? "Tu chofer llegó — dirígete al vehículo"
      : viaje.estado === "en_curso" ? "Viaje en curso"
      : "Tu chofer va en camino";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Rastreando tu ChatGo</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1419;color:#e6e6e6;display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:10px 14px;flex-shrink:0;}
.header-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.logo{background:#1D9E75;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.header-title{font-size:14px;font-weight:600;}
.header-sub{font-size:12px;color:#8b949e;}
.status-row{display:flex;align-items:center;gap:8px;font-size:12px;}
.dot{width:8px;height:8px;border-radius:50%;background:#1D9E75;}
.dot.pulse{animation:p 2s infinite;}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
.dot.off{background:#f85149;animation:none;}
.status-txt{color:#1D9E75;font-weight:500;}
.status-txt.fin{color:#f85149;}
.update-ts{font-size:10px;color:#8b949e;margin-left:auto;}
#map{flex:1;}
.info{background:#161b22;border-top:1px solid #30363d;padding:10px 14px;flex-shrink:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.info-item{background:#0d1117;border-radius:8px;padding:8px 10px;}
.info-label{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;}
.info-value{font-size:13px;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.info-wide{grid-column:span 2;}
.overlay{display:none;position:fixed;inset:0;background:rgba(15,20,25,.96);align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;padding:24px;z-index:999;}
.overlay.show{display:flex;}
.ov-icon{font-size:52px;}
.ov-title{font-size:20px;font-weight:600;}
.ov-sub{font-size:14px;color:#8b949e;max-width:280px;line-height:1.5;}
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="logo">🚖</div>
    <div>
      <div class="header-title">ChatGo · Rastreo en vivo</div>
      <div class="header-sub">${escapeHtml(viaje.choferNombre)} · ${emoji} ${label} ${escapeHtml(viaje.choferPlaca)}</div>
    </div>
  </div>
  <div class="status-row">
    <div class="dot ${activo ? "pulse" : "off"}" id="dot"></div>
    <span class="status-txt ${activo ? "" : "fin"}" id="stxt">${activo ? estadoTexto : "Viaje finalizado"}</span>
    <span class="update-ts" id="ts"></span>
  </div>
</div>

<div id="map"></div>

<div class="info">
  <div class="info-item">
    <div class="info-label">Chofer</div>
    <div class="info-value">${escapeHtml(viaje.choferNombre)}</div>
  </div>
  <div class="info-item">
    <div class="info-label">Vehículo</div>
    <div class="info-value">${emoji} ${label} · ${escapeHtml(viaje.choferPlaca)}</div>
  </div>
  <div class="info-item info-wide">
    <div class="info-label">📍 Origen</div>
    <div class="info-value">${viaje.origen?.nombre || "Tu ubicación"}</div>
  </div>
  <div class="info-item info-wide">
    <div class="info-label">🏁 Destino</div>
    <div class="info-value">${viaje.destino?.nombre || "Tu destino"}</div>
  </div>
  <div class="info-item">
    <div class="info-label">Distancia</div>
    <div class="info-value">${viaje.distanciaKm} km</div>
  </div>
  <div class="info-item">
    <div class="info-label">Precio</div>
    <div class="info-value">Bs ${viaje.precioTotal}</div>
  </div>
</div>

<div class="overlay ${activo ? "" : "show"}" id="overlay">
  <div class="ov-icon">✅</div>
  <div class="ov-title">Viaje finalizado</div>
  <div class="ov-sub">Gracias por usar ChatGo.<br>¡Hasta la próxima!</div>
</div>

<script>
const VID = "${viaje._id}";
const GMKEY = "${CONFIG.GOOGLE_MAPS_KEY}";
const ORIGEN = ${JSON.stringify(viaje.origen || {})};
const DESTINO = ${JSON.stringify(viaje.destino || {})};
let map, taxiMarker, terminado = ${activo ? "false" : "true"};
let segundos = 0, timer;

function initMap() {
  const centro = { lat: ${viaje.origen?.lat || -17.3935}, lng: ${viaje.origen?.lng || -66.157} };
  map = new google.maps.Map(document.getElementById("map"), {
    center: centro, zoom: 14,
    disableDefaultUI: true, zoomControl: true,
    styles: [
      {elementType:"geometry",stylers:[{color:"#212121"}]},
      {elementType:"labels.text.fill",stylers:[{color:"#757575"}]},
      {elementType:"labels.text.stroke",stylers:[{color:"#212121"}]},
      {featureType:"road",elementType:"geometry",stylers:[{color:"#484848"}]},
      {featureType:"road.highway",elementType:"geometry",stylers:[{color:"#3c3c3c"}]},
      {featureType:"water",elementType:"geometry",stylers:[{color:"#000000"}]},
    ],
  });

  const mkCircle = (pos, color, title) => new google.maps.Marker({
    position: pos, map, title,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: color, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
    zIndex: 1,
  });

  if (ORIGEN.lat) mkCircle({ lat: ORIGEN.lat, lng: ORIGEN.lng }, "#1D9E75", "Origen");
  if (DESTINO.lat) mkCircle({ lat: DESTINO.lat, lng: DESTINO.lng }, "#f85149", "Destino");

  if (!terminado) poll();
  else showFin();
}

const TAXI_ICON = {
  url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><circle cx="21" cy="21" r="21" fill="#1D9E75"/><text x="21" y="28" text-anchor="middle" font-size="22">🚖</text></svg>'),
  scaledSize: new google.maps.Size(42, 42),
  anchor: new google.maps.Point(21, 21),
};

async function poll() {
  if (terminado) return;
  try {
    const r = await fetch("/track/" + VID + "/pos");
    const d = await r.json();
    if (d.error === "not_found") { showFin("Link inválido"); return; }
    if (d.terminado) { showFin(); return; }

    const pos = { lat: d.lat, lng: d.lng };
    if (!taxiMarker) {
      taxiMarker = new google.maps.Marker({ position: pos, map, icon: TAXI_ICON, title: d.choferNombre, zIndex: 10 });
      map.setCenter(pos);
    } else {
      taxiMarker.setPosition(pos);
    }

    const stxt = document.getElementById("stxt");
    stxt.textContent = d.estado === "esperando_pasajero"
      ? "Tu chofer llegó — dirígete al vehículo"
      : d.estado === "en_curso" ? "Viaje en curso"
      : "Tu chofer va en camino";

    // Contador desde última actualización
    clearInterval(timer);
    segundos = 0;
    document.getElementById("ts").textContent = "Ahora mismo";
    timer = setInterval(() => {
      segundos++;
      document.getElementById("ts").textContent = segundos < 60
        ? "Actualizado hace " + segundos + "s"
        : "Actualizado hace " + Math.floor(segundos/60) + " min";
    }, 1000);

  } catch(e) { console.error(e); }
  setTimeout(poll, 15000);
}

function showFin(msg) {
  terminado = true;
  clearInterval(timer);
  document.getElementById("overlay").classList.add("show");
  document.getElementById("dot").classList.remove("pulse");
  document.getElementById("dot").classList.add("off");
  document.getElementById("stxt").classList.add("fin");
  document.getElementById("stxt").textContent = "Viaje finalizado";
  if (msg) document.querySelector(".ov-sub").textContent = msg;
}

window.initMap = initMap;
</script>
<script async defer src="https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_KEY}&callback=initMap&language=es"></script>
</body></html>`);
  } catch (e) {
    log.error("[TRACK_PAGE]", e.message);
    res.status(500).send("Error: " + e.message);
  }
});

app.get("/admin", requireAuth(), (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGo Admin · RastreoPlus</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1419;color:#e6e6e6;padding:14px;font-size:14px;}h1{color:#00d97e;font-size:22px;margin-bottom:4px;}.subtitle{color:#8b949e;margin-bottom:16px;font-size:12px;}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;}.btn{padding:6px 12px;background:#1f6feb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;}.btn:hover{background:#388bfd;}.btn.muted{background:#30363d;}.updated{color:#8b949e;font-size:11px;}.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:18px;}.stat{background:#161b22;padding:10px 12px;border-radius:8px;border:1px solid #30363d;}.stat-label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}.stat-value{font-size:22px;font-weight:bold;margin-top:4px;}.stat-value.green{color:#3fb950;}.stat-value.yellow{color:#d29922;}.stat-value.red{color:#f85149;}.stat-value.blue{color:#58a6ff;}.section{background:#161b22;padding:14px;border-radius:8px;border:1px solid #30363d;margin-bottom:14px;}.section h2{font-size:15px;color:#58a6ff;margin-bottom:10px;display:flex;align-items:center;gap:8px;}.badge{padding:2px 8px;background:#30363d;border-radius:10px;font-size:11px;color:#8b949e;}table{width:100%;border-collapse:collapse;font-size:12px;}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #21262d;}th{color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px;}tr:hover{background:#0d1117;}.estado{padding:2px 8px;border-radius:10px;font-size:11px;display:inline-block;}.estado-libre{background:#0d3d20;color:#3fb950;}.estado-ocupado{background:#3d2c0d;color:#d29922;}.estado-offline{background:#3d0d0d;color:#f85149;}.gps-ok{color:#3fb950;}.gps-old{color:#d29922;}.gps-no{color:#f85149;}.pago-ok{color:#3fb950;}.pago-no{color:#f85149;}.vehiculo-auto{color:#58a6ff;}.vehiculo-moto{color:#d29922;}a.maplink{color:#58a6ff;text-decoration:none;}a.maplink:hover{text-decoration:underline;}.empty{color:#8b949e;font-style:italic;text-align:center;padding:18px;}.loading{text-align:center;color:#8b949e;padding:40px;}.filter{padding:4px 8px;background:#0d1117;border:1px solid #30363d;color:#e6e6e6;border-radius:4px;font-size:12px;}.truncate{max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}@media (max-width:768px){body{padding:8px;font-size:13px;}.stats-grid{grid-template-columns:repeat(2,1fr);}table{font-size:11px;}th,td{padding:6px 4px;}}</style>
</head><body>
<h1>🚖 ChatGo Admin</h1>
<div class="subtitle">RastreoPlus · Cochabamba · v4 FIXED</div>
<div class="toolbar">
  <button class="btn" onclick="cargar()">🔄 Actualizar</button>
  <button class="btn muted" id="btnAuto">▶️ Auto-refresh OFF</button>
  <a href="/admin/mapa" class="btn" style="text-decoration:none;background:#0d3d20;">🗺️ Mapa choferes</a>
  <span class="updated" id="updated">Cargando...</span>
</div>
<div id="content"><div class="loading">⏳ Cargando datos...</div></div>
<script>
let autoRefresh=false,intervaloRefresh=null;
document.getElementById("btnAuto").onclick=()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("btnAuto");if(autoRefresh){btn.textContent="⏸️ Auto-refresh ON (15s)";btn.style.background="#0d3d20";intervaloRefresh=setInterval(cargar,15000);}else{btn.textContent="▶️ Auto-refresh OFF";btn.style.background="#30363d";if(intervaloRefresh)clearInterval(intervaloRefresh);}};
function fmtHora(d){if(!d)return"—";return new Date(d).toLocaleString("es-BO",{timeZone:"America/La_Paz",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});}
function fmtTel(p){return p?"+"+p:"—";}
function gpsBadge(pos){if(!pos)return'<span class="gps-no">❌ Sin GPS</span>';if(pos.hace_min<=5)return'<span class="gps-ok">📡 '+pos.hace_min+'min</span>';if(pos.hace_min<=15)return'<span class="gps-old">⚠️ '+pos.hace_min+'min</span>';return'<span class="gps-no">🔴 '+pos.hace_min+'min</span>';}
function estadoBadge(estado){return'<span class="estado estado-'+estado+'">'+estado.toUpperCase()+'</span>';}
function tipoVehBadge(t){const e=t==="moto"?"🏍️":"🚗";return'<span class="vehiculo-'+t+'">'+e+' '+t.toUpperCase()+'</span>';}
function pagoBadge(c){if(c.pagoAlDia)return'<span class="pago-ok">✅ Pagado hoy</span>';if(c.pagoDiario?.pagado&&!c.pagoDiario?.aprobado)return'<span class="gps-old">⏳ Pendiente</span>';return'<span class="pago-no">❌ Sin pago</span>';}
async function cargar(){try{const r=await fetch("/admin/data");const d=await r.json();if(d.error){document.getElementById("content").innerHTML='<div class="section">❌ Error: '+d.error+'</div>';return;}renderizar(d);document.getElementById("updated").textContent="Actualizado: "+new Date().toLocaleTimeString("es-BO");}catch(e){document.getElementById("content").innerHTML='<div class="section">❌ Error de red: '+e.message+'</div>';}}
function renderizar(d){const s=d.stats;let html='';
html+='<div class="stats-grid">';
html+='<div class="stat"><div class="stat-label">Choferes</div><div class="stat-value blue">'+s.choferesTotal+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟢 Libres</div><div class="stat-value green">'+s.choferesLibres+'</div></div>';
html+='<div class="stat"><div class="stat-label">🟡 Ocupados</div><div class="stat-value yellow">'+s.choferesOcupados+'</div></div>';
html+='<div class="stat"><div class="stat-label">🔴 Offline</div><div class="stat-value red">'+s.choferesOffline+'</div></div>';
html+='<div class="stat"><div class="stat-label">📡 GPS reciente</div><div class="stat-value blue">'+s.choferesConGPSReciente+'</div></div>';
html+='<div class="stat"><div class="stat-label">💰 Pagados hoy</div><div class="stat-value green">'+s.choferesPagadosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">🚖 Activos</div><div class="stat-value yellow">'+s.viajesActivos+'</div></div>';
html+='<div class="stat"><div class="stat-label">⏳ En espera</div><div class="stat-value yellow">'+s.enListaEspera+'</div></div>';
html+='<div class="stat"><div class="stat-label">Usuarios</div><div class="stat-value blue">'+s.totalUsuarios+'</div></div>';
html+='<div class="stat"><div class="stat-label">+ Hoy</div><div class="stat-value green">'+s.usuariosNuevosHoy+'</div></div>';
html+='<div class="stat"><div class="stat-label">Viajes 24h</div><div class="stat-value blue">'+s.viajes24h+'</div></div>';
html+='<div class="stat"><div class="stat-label">✅ Completados</div><div class="stat-value green">'+s.viajesCompletados24h+'</div></div>';
if(s.rating)html+='<div class="stat"><div class="stat-label">⭐ Rating</div><div class="stat-value yellow">'+s.rating.promedio+' <span style="font-size:11px;color:#8b949e">('+s.rating.cantidad+')</span></div></div>';
html+='<div class="stat"><div class="stat-label">🎁 Códigos</div><div class="stat-value green">'+s.codigosActivos+'</div></div>';
html+='</div>';
html+='<div class="section"><h2>👥 Choferes <span class="badge">'+d.choferes.length+'</span> <select class="filter" id="filtroChofer" onchange="filtrarChoferes()"><option value="todos">Todos</option><option value="libre">Libres</option><option value="ocupado">Ocupados</option><option value="offline">Offline</option><option value="con-gps">Con GPS</option><option value="sin-gps">Sin GPS</option><option value="pagado">Pagados</option><option value="impago">Sin pagar</option></select></h2>';
if(d.choferes.length===0){html+='<div class="empty">No hay choferes registrados.</div>';}else{html+='<div style="overflow-x:auto"><table id="tablaChoferes"><thead><tr><th>Estado</th><th>Nombre</th><th>Placa</th><th>Tipo</th><th>Teléfono</th><th>Wialon ID</th><th>GPS</th><th>Pago</th><th>Viajes</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.choferes.forEach(c=>{let mapaLink="—";if(c.ultimaPos)mapaLink='<a class="maplink" href="https://www.google.com/maps?q='+c.ultimaPos.lat+','+c.ultimaPos.lng+'" target="_blank">🗺️ Ver</a>';const rating=c.ratingCantidad>0?c.ratingPromedio.toFixed(1)+' ('+c.ratingCantidad+')':'—';let clase="chofer";clase+=" estado-"+c.estado;clase+=c.ultimaPos&&c.ultimaPos.hace_min<=15?" con-gps":" sin-gps";clase+=c.pagoAlDia?" pagado":" impago";html+='<tr class="'+clase+'"><td>'+estadoBadge(c.estado)+'</td><td class="truncate" title="'+(c.nombre||"")+'">'+(c.nombre||"—")+'</td><td>'+(c.placa||"—")+'</td><td>'+tipoVehBadge(c.tipoVehiculo)+'</td><td>'+fmtTel(c.phone)+'</td><td>'+(c.wialonId||"—")+'</td><td>'+gpsBadge(c.ultimaPos)+'</td><td>'+pagoBadge(c)+'</td><td>'+c.viajesTotal+'</td><td>'+rating+'</td><td>'+mapaLink+'</td></tr>';});
html+='</tbody></table></div>';}html+='</div>';
html+='<div class="section"><h2>🚖 Viajes activos <span class="badge">'+d.viajesActivos.length+'</span></h2>';
if(d.viajesActivos.length===0){html+='<div class="empty">No hay viajes activos.</div>';}else{html+='<div style="overflow-x:auto"><table><thead><tr><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Origen</th><th>Destino</th><th>Km</th><th>Precio</th><th>Inicio</th><th>Mapa</th></tr></thead><tbody>';d.viajesActivos.forEach(v=>{html+='<tr><td><span class="estado estado-'+(v.estado==="en_curso"?"libre":"ocupado")+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'<br><small>'+(v.choferPlaca||"")+'</small></td><td class="truncate">'+(v.origen?.nombre||"📍")+'</td><td class="truncate">'+(v.destino?.nombre||"🏁")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+fmtHora(v.fechaInicio)+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});html+='</tbody></table></div>';}html+='</div>';
if(d.listaEspera.length>0){html+='<div class="section"><h2>⏳ Lista de espera <span class="badge">'+d.listaEspera.length+'</span></h2><div style="overflow-x:auto"><table><thead><tr><th>Pasajero</th><th>Tipo</th><th>Origen</th><th>Destino</th><th>Precio</th><th>Esperando desde</th><th>Notificado</th></tr></thead><tbody>';d.listaEspera.forEach(e=>{html+='<tr><td>'+fmtTel(e.userPhone)+'</td><td>'+(e.tipoVehiculoSolicitado?tipoVehBadge(e.tipoVehiculoSolicitado):"—")+'</td><td class="truncate">'+(e.origen?.nombre||"—")+'</td><td class="truncate">'+(e.destino?.nombre||"—")+'</td><td>Bs '+(e.precio||"—")+'</td><td>'+fmtHora(e.timestamp)+'</td><td>'+(e.notificado?"✅":"⏳")+'</td></tr>';});html+='</tbody></table></div></div>';}
html+='<div class="section"><h2>📜 Últimos 20 viajes</h2><div style="overflow-x:auto"><table><thead><tr><th>Fecha</th><th>Estado</th><th>Tipo</th><th>Pasajero</th><th>Chofer</th><th>Km</th><th>Precio</th><th>⭐</th><th>Mapa</th></tr></thead><tbody>';
d.viajesRecientes.forEach(v=>{const rTxt=v.ratingPasajero?"⭐"+v.ratingPasajero:"—";let clE="offline";if(v.estado==="completado")clE="libre";else if(["en_curso","en_camino","esperando_pasajero","pendiente"].includes(v.estado))clE="ocupado";html+='<tr><td>'+fmtHora(v.createdAt||v.fechaInicio)+'</td><td><span class="estado estado-'+clE+'">'+v.estado+'</span></td><td>'+tipoVehBadge(v.tipoVehiculo||"auto")+'</td><td>'+fmtTel(v.usuarioPhone)+'</td><td>'+(v.choferNombre||"—")+'</td><td>'+(v.distanciaKm||"—")+' km</td><td>Bs '+(v.precioTotal||"—")+'</td><td>'+rTxt+'</td><td><a class="maplink" href="/admin/viaje/'+v._id+'" target="_blank">🗺️</a></td></tr>';});
html+='</tbody></table></div></div>';
document.getElementById("content").innerHTML=html;}
function filtrarChoferes(){const filtro=document.getElementById("filtroChofer").value;const filas=document.querySelectorAll("#tablaChoferes tbody tr");filas.forEach(f=>{let m=true;if(filtro==="libre")m=f.classList.contains("estado-libre");else if(filtro==="ocupado")m=f.classList.contains("estado-ocupado");else if(filtro==="offline")m=f.classList.contains("estado-offline");else if(filtro==="con-gps")m=f.classList.contains("con-gps");else if(filtro==="sin-gps")m=f.classList.contains("sin-gps");else if(filtro==="pagado")m=f.classList.contains("pagado");else if(filtro==="impago")m=f.classList.contains("impago");f.style.display=m?"":"none";});}
cargar();
</script></body></html>`);
});

app.get("/", (_req, res) => { res.send("ChatGo v5.30 - RastreoPlus - Operativo ✅"); });

// ═══════════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════


};
