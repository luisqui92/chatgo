// ═══════════════════════════════════════════════════════════════════════════
// ChatGo v3 - Bot de Taxi por WhatsApp
// RastreoPlus - Cochabamba, Bolivia
// Features: Auto/Moto, Paradas, Observaciones, Calificaciones, SOS,
//           Tarifa nocturna, Códigos promo, Bloqueo de canceladores, etc.
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const FormData = require("form-data");

const app = express();
app.use(express.json());

// ─── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY,
  WIALON_TOKEN: process.env.WIALON_TOKEN,
  OPENAI_KEY: process.env.OPENAI_KEY,
  MONGODB_URI: process.env.MONGODB_URI,
  ADMIN_PHONE: process.env.ADMIN_PHONE,
  QR_IMAGE_URL: process.env.QR_IMAGE_URL,
  RADIO_BUSQUEDA_KM: 4,
  ESPERA_LIBRE_MIN: 5,
  COBRO_ESPERA_BS_MIN: 2,
  MAX_PARADAS: 3,
  RECARGO_NOCTURNO: 0.15,
  HORA_NOCTURNO_INICIO: 23,
  HORA_NOCTURNO_FIN: 5,
  CANCELACIONES_BLOQUEO: 3,
  TIEMPO_BLOQUEO_MIN: 60,
  GPS_MAXIMO_MIN: 10,
  DESCUENTO_MAX: 0.40,
  CALIFICACIONES_MALAS_LIMITE: 3,
  PROMO_VIGENCIA_DIAS: 14,
};

// ─── MONGODB ────────────────────────────────────────────────────────────────
mongoose.connect(CONFIG.MONGODB_URI)
  .then(() => console.log("✅ MongoDB conectado"))
  .catch(e => console.error("❌ Error MongoDB:", e.message));

const usuarioSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  nombre: String,
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
  viajesTotal: { type: Number, default: 0 },
  cancelacionesHoy: { type: Number, default: 0 },
  fechaUltimaCancelacion: Date,
  bloqueadoHasta: Date,
  codigoReferido: String,
  referidoPor: String,
  amigosReferidos: { type: Number, default: 0 },
  rutasFrecuentes: [{
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    contador: { type: Number, default: 1 },
  }],
});

const choferSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  wialonId: String,
  placa: String,
  nombre: String,
  tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto" },
  estado: { type: String, default: "offline" },
  pagoDiario: {
    fecha: Date,
    pagado: { type: Boolean, default: false },
    aprobado: { type: Boolean, default: false },
  },
  viajesTotal: { type: Number, default: 0 },
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
  calificaciones: [{
    estrellas: Number,
    fecha: { type: Date, default: Date.now },
    viajeId: String,
  }],
  promedioCalificacion: { type: Number, default: 5.0 },
  cancelacionesTotal: { type: Number, default: 0 },
  notificadoMalCalificado: { type: Boolean, default: false },
});

const viajeSchema = new mongoose.Schema({
  usuarioPhone: String,
  choferPhone: String,
  choferNombre: String,
  choferPlaca: String,
  tipoVehiculo: String,
  origen: { lat: Number, lng: Number, nombre: String },
  paradas: [{ lat: Number, lng: Number, nombre: String, tiempoEsperaMin: Number }],
  destino: { lat: Number, lng: Number, nombre: String },
  observaciones: String,
  distanciaKm: Number,
  precioBase: Number,
  precioExtraEspera: { type: Number, default: 0 },
  recargoNocturno: { type: Number, default: 0 },
  descuento: { type: Number, default: 0 },
  precioTotal: Number,
  precioPorKm: Number,
  esNocturno: { type: Boolean, default: false },
  codigoPromoUsado: String,
  estado: { type: String, default: "pendiente" },
  fechaInicio: { type: Date, default: Date.now },
  fechaFin: Date,
  calificacionUsuario: Number,
  cancelado: { type: Boolean, default: false },
  motivoCancelacion: String,
  pagado: { type: Boolean, default: false },
  sosActivado: { type: Boolean, default: false },
});

const codigoPromoSchema = new mongoose.Schema({
  codigo: { type: String, unique: true },
  descuentoPorcentaje: Number,
  descuentoMaxBs: Number,
  asignadoAPhone: String,
  generadoPorPhone: String,
  usado: { type: Boolean, default: false },
  fechaUso: Date,
  vencimiento: Date,
});

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const CodigoPromo = mongoose.model("CodigoPromo", codigoPromoSchema);

const sessions = {};
const listaEspera = {};

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

function esHorarioNocturno() {
  const hora = new Date().getHours();
  return hora >= CONFIG.HORA_NOCTURNO_INICIO || hora < CONFIG.HORA_NOCTURNO_FIN;
}

function calcularPrecio(km, tipoVehiculo, aplicarNocturno) {
  if (tipoVehiculo === undefined) tipoVehiculo = "auto";
  if (aplicarNocturno === undefined) aplicarNocturno = true;
  
  let precioPorKm, minimo;
  if (tipoVehiculo === "moto") {
    if (km < 4) precioPorKm = 2.5;
    else if (km < 10) precioPorKm = 2.0;
    else precioPorKm = 1.5;
    minimo = 4;
  } else {
    if (km < 4) precioPorKm = 4.0;
    else if (km < 10) precioPorKm = 3.5;
    else precioPorKm = 2.5;
    minimo = 6;
  }
  let total = Math.max(km * precioPorKm, minimo);
  let recargo = 0;
  let nocturno = false;
  if (aplicarNocturno && esHorarioNocturno()) {
    recargo = total * CONFIG.RECARGO_NOCTURNO;
    total += recargo;
    nocturno = true;
  }
  return {
    total: Math.round(total),
    base: Math.round(total - recargo),
    recargoNocturno: Math.round(recargo),
    precioPorKm,
    nocturno,
  };
}

function distanciaEntrePuntos(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function generarCodigoPromo(phone) {
  const sufijo = phone.slice(-4);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CHATGO${sufijo}${random}`;
}

function detectarIncompatibilidadMoto(observaciones) {
  if (!observaciones) return null;
  const texto = observaciones.toLowerCase();
  const incompatibles = [
    { palabras: ["perro grande", "perrita", "mascota grande", "perrazo"], razon: "mascota" },
    { palabras: ["maletas", "valijas", "equipaje grande", "maleta grande"], razon: "equipaje" },
    { palabras: ["muebles", "mueble", "compras grandes", "tv", "televisor", "refrigerador", "heladera"], razon: "muebles" },
    { palabras: ["bebé", "bebe", "embarazo", "embarazada", "guagua"], razon: "personas vulnerables" },
    { palabras: ["muletas", "silla de ruedas", "discapacidad"], razon: "movilidad" },
    { palabras: ["3 personas", "tres personas", "4 personas", "cuatro personas"], razon: "más de 1 persona" },
    { palabras: ["frágil", "fragil", "vidrio"], razon: "carga frágil" },
  ];
  for (const inc of incompatibles) {
    for (const p of inc.palabras) {
      if (texto.includes(p)) return inc.razon;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS
// ═══════════════════════════════════════════════════════════════════════════

async function calcularDistanciaConParadas(origen, paradas, destino) {
  const puntos = [origen].concat(paradas || []).concat([destino]);
  let kmTotal = 0;
  let duracionTotal = 0;
  for (let i = 0; i < puntos.length - 1; i++) {
    try {
      const res = await axios.get("https://maps.googleapis.com/maps/api/distancematrix/json", {
        params: {
          origins: `${puntos[i].lat},${puntos[i].lng}`,
          destinations: `${puntos[i+1].lat},${puntos[i+1].lng}`,
          key: CONFIG.GOOGLE_MAPS_KEY,
          mode: "driving",
        },
      });
      const element = res.data.rows?.[0]?.elements?.[0];
      if (element?.status === "OK") {
        kmTotal += element.distance.value / 1000;
        duracionTotal += element.duration.value / 60;
      } else {
        kmTotal += distanciaEntrePuntos(puntos[i].lat, puntos[i].lng, puntos[i+1].lat, puntos[i+1].lng);
      }
    } catch {
      kmTotal += distanciaEntrePuntos(puntos[i].lat, puntos[i].lng, puntos[i+1].lat, puntos[i+1].lng);
    }
  }
  if (duracionTotal === 0) duracionTotal = kmTotal * 3;
  return {
    km: Math.round(kmTotal * 10) / 10,
    duracion: `${Math.round(duracionTotal)} min`,
    minutos: Math.round(duracionTotal),
  };
}

async function obtenerDireccion(lat, lng) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, key: CONFIG.GOOGLE_MAPS_KEY, language: "es" },
    });
    if (!res.data.results?.length) return null;
    const comps = res.data.results[0].address_components;
    const calle = comps.find(c => c.types.includes("route"))?.long_name || "";
    const numero = comps.find(c => c.types.includes("street_number"))?.long_name || "";
    const barrio = comps.find(c => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name || "";
    if (calle) return numero ? `${calle} ${numero}` : (barrio ? `${calle}, ${barrio}` : calle);
    return res.data.results[0].formatted_address.split(",")[0];
  } catch { return null; }
}

async function geocodificarDireccion(direccion) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: `${direccion}, Cochabamba, Bolivia`, key: CONFIG.GOOGLE_MAPS_KEY },
    });
    if (!res.data.results?.length) return null;
    const loc = res.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, nombre: res.data.results[0].formatted_address };
  } catch { return null; }
}

function generarLinkRutaCompleta(origen, paradas, destino) {
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origen.lat},${origen.lng}&destination=${destino.lat},${destino.lng}`;
  if (paradas?.length) {
    const waypoints = paradas.map(p => `${p.lat},${p.lng}`).join("|");
    url += `&waypoints=${waypoints}`;
  }
  url += "&travelmode=driving";
  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
// WIALON
// ═══════════════════════════════════════════════════════════════════════════

async function wialonLogin() {
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: { svc: "token/login", params: JSON.stringify({ token: CONFIG.WIALON_TOKEN }) },
  });
  if (!res.data.eid) throw new Error("Wialon login failed");
  return res.data.eid;
}

async function obtenerUbicacionChofer(wialonId) {
  const eid = await wialonLogin();
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "core/search_item",
      params: JSON.stringify({ id: parseInt(wialonId), flags: 4294967295 }),
      sid: eid,
    },
  });
  const item = res.data.item;
  if (!item?.pos) throw new Error("Sin GPS disponible");
  const pos = item.pos;
  const minutos = Math.round((Date.now() / 1000 - (pos.t || 0)) / 60);
  console.log(`[WIALON] ${wialonId} (${item.nm}): lat=${pos.y}, lng=${pos.x}, hace ${minutos}min`);
  return { lat: pos.y, lng: pos.x, minutos };
}

async function generarLinkLocator(wialonId) {
  try {
    const eid = await wialonLogin();
    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "locator/create_hash",
        params: JSON.stringify({ items: [parseInt(wialonId)], duration: 7200, type: 0 }),
        sid: eid,
      },
    });
    if (res.data?.hash) return `https://hosting.wialon.com/locator/index.html?t=${res.data.hash}`;
    throw new Error("No hash");
  } catch (e) {
    try {
      const pos = await obtenerUbicacionChofer(wialonId);
      return `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
    } catch { return "https://hosting.wialon.com/"; }
  }
}

async function buscarChoferDisponible(origenUsuario, tipoVehiculo) {
  if (tipoVehiculo === undefined) tipoVehiculo = "auto";
  const choferes = await Chofer.find({ estado: "libre", tipoVehiculo });
  if (!choferes.length) {
    console.log(`[BUSCAR] No hay choferes ${tipoVehiculo} libres`);
    return null;
  }
  console.log(`[BUSCAR] ${choferes.length} choferes ${tipoVehiculo} libres`);
  let mejorChofer = null;
  let menorDist = Infinity;
  for (const chofer of choferes) {
    try {
      const pos = await obtenerUbicacionChofer(chofer.wialonId);
      if (pos.minutos > CONFIG.GPS_MAXIMO_MIN) {
        console.log(`[BUSCAR] ${chofer.nombre}: GPS viejo (${pos.minutos}min) - SALTADO`);
        continue;
      }
      const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.lat, pos.lng);
      console.log(`[BUSCAR] ${chofer.nombre}: ${dist.toFixed(2)}km`);
      if (dist > CONFIG.RADIO_BUSQUEDA_KM) {
        console.log(`[BUSCAR] ${chofer.nombre}: fuera de radio`);
        continue;
      }
      if (dist < menorDist) {
        menorDist = dist;
        mejorChofer = { ...chofer.toObject(), ubicacion: pos, distanciaAlUsuario: dist };
      }
    } catch (e) { console.error(`[BUSCAR] Error ${chofer.wialonId}:`, e.message); }
  }
  return mejorChofer;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENAI
// ═══════════════════════════════════════════════════════════════════════════

async function transcribirAudio(audioUrl) {
  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
  });
  const formData = new FormData();
  formData.append("file", Buffer.from(audioRes.data), { filename: "audio.ogg", contentType: "audio/ogg" });
  formData.append("model", "whisper-1");
  formData.append("language", "es");
  const res = await axios.post("https://api.openai.com/v1/audio/transcriptions", formData, {
    headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}`, ...formData.getHeaders() },
  });
  return res.data.text;
}

async function extraerUbicaciones(texto) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: `Extrae origen, destino, paradas y observaciones de mensajes de taxi en Cochabamba, Bolivia.
Responde SOLO JSON: {"origen": "lugar", "destino": "lugar", "paradas": ["lugar1"], "observaciones": "texto"}
Si no hay alguno, usa null o array vacío.
Detectar paradas si dice "pasando por", "primero a".
Detectar observaciones si menciona: mascotas, equipaje, niños, parrilla, etc.`,
      }, { role: "user", content: texto }],
      max_tokens: 250,
    }, { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` } });
    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch { return { origen: null, destino: null, paradas: [], observaciones: null }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP API
// ═══════════════════════════════════════════════════════════════════════════

async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: texto } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
  } catch (e) { console.error("[WSP] Error:", e.response?.data?.error?.message || e.message); }
}

async function enviarBotones(to, texto, botones) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "button",
          body: { text: texto },
          action: {
            buttons: botones.slice(0, 3).map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
  } catch (e) { console.error("[WSP] Error botones:", e.response?.data?.error?.message || e.message); }
}

async function enviarImagen(to, imageUrl, caption) {
  if (caption === undefined) caption = "";
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
  } catch (e) { console.error("[WSP] Error imagen:", e.response?.data?.error?.message || e.message); }
}

async function obtenerUrlMedia(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
  });
  return res.data.url;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUTAS Y CÓDIGOS PROMO
// ═══════════════════════════════════════════════════════════════════════════

async function verificarRutaFrecuente(phone) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario?.rutasFrecuentes?.length) return null;
  const top = usuario.rutasFrecuentes.sort((a, b) => b.contador - a.contador)[0];
  return top.contador >= 3 ? top : null;
}

async function guardarRutaFrecuente(phone, origen, destino) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario) return;
  const existente = usuario.rutasFrecuentes.find(r =>
    Math.abs(r.origen.lat - origen.lat) < 0.001 &&
    Math.abs(r.destino.lat - destino.lat) < 0.001
  );
  if (existente) existente.contador += 1;
  else usuario.rutasFrecuentes.push({ origen, destino, contador: 1 });
  await usuario.save();
}

async function generarCodigoPromoUsuario(phoneReferidor, phoneDestinatario) {
  const codigo = generarCodigoPromo(phoneDestinatario);
  const fechaVenc = new Date();
  fechaVenc.setDate(fechaVenc.getDate() + CONFIG.PROMO_VIGENCIA_DIAS);
  await CodigoPromo.create({
    codigo,
    descuentoPorcentaje: CONFIG.DESCUENTO_MAX,
    descuentoMaxBs: 15,
    asignadoAPhone: phoneDestinatario,
    generadoPorPhone: phoneReferidor,
    vencimiento: fechaVenc,
  });
  return codigo;
}

async function aplicarCodigoPromo(codigo, phone, precioBase) {
  const promo = await CodigoPromo.findOne({
    codigo: codigo.toUpperCase().trim(),
    asignadoAPhone: phone,
    usado: false,
  });
  if (!promo) return { aplicado: false, mensaje: "Código inválido o ya usado" };
  if (promo.vencimiento < new Date()) return { aplicado: false, mensaje: "Código vencido" };
  let descuento = precioBase * promo.descuentoPorcentaje;
  if (descuento > promo.descuentoMaxBs) descuento = promo.descuentoMaxBs;
  return {
    aplicado: true,
    descuento: Math.round(descuento),
    porcentaje: promo.descuentoPorcentaje * 100,
    promoId: promo._id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  const ahora = Date.now();
  for (const [userPhone, espera] of Object.entries(listaEspera)) {
    const segundos = (ahora - espera.timestamp) / 1000;
    if (segundos > 120 && !espera.notificado) {
      espera.notificado = true;
      if (sessions[userPhone]) sessions[userPhone].step = "sin_chofer";
      await enviarMensaje(userPhone,
        `😔 No tenemos ${espera.tipoVehiculo === "moto" ? "motos" : "autos"} disponibles en ${CONFIG.RADIO_BUSQUEDA_KM}km.\n\nTe avisaremos en cuanto haya uno. 🚖`
      );
    }
    if (segundos > 300) {
      delete listaEspera[userPhone];
      if (sessions[userPhone]) sessions[userPhone].step = "inicio";
      continue;
    }
    if (espera.notificado && !espera.recordatorioEnviado) {
      try {
        const chofer = await buscarChoferDisponible(espera.session.origen, espera.tipoVehiculo);
        if (chofer) {
          espera.recordatorioEnviado = true;
          delete listaEspera[userPhone];
          if (sessions[userPhone]) sessions[userPhone].step = "sin_chofer";
          await enviarBotones(userPhone,
            `🚖 ¡Hay un ${espera.tipoVehiculo} disponible cerca!\n¿Asignamos uno?`,
            [
              { id: "confirmar_viaje_recordatorio", title: "✅ Sí, taxi" },
              { id: "cancelar_viaje", title: "❌ Ya no" },
            ]
          );
        }
      } catch (e) { console.error("[ESPERA] Error:", e.message); }
    }
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function asignarChofer(userPhone, session) {
  const chofer = await buscarChoferDisponible(session.origen, session.tipoVehiculo);
  if (!chofer) {
    listaEspera[userPhone] = {
      session, timestamp: Date.now(),
      notificado: false, recordatorioEnviado: false,
      tipoVehiculo: session.tipoVehiculo,
    };
    await enviarMensaje(userPhone,
      `⏳ Buscando ${session.tipoVehiculo === "moto" ? "moto" : "auto"} en ${CONFIG.RADIO_BUSQUEDA_KM}km...`
    );
    return;
  }
  const viaje = await Viaje.create({
    usuarioPhone: userPhone,
    choferPhone: chofer.phone,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa,
    tipoVehiculo: session.tipoVehiculo,
    origen: session.origen,
    paradas: session.paradas || [],
    destino: session.destino,
    observaciones: session.observaciones || "",
    distanciaKm: session.distancia,
    precioBase: session.precioBase,
    recargoNocturno: session.recargoNocturno,
    descuento: session.descuento || 0,
    precioTotal: session.precio,
    precioPorKm: session.precioPorKm,
    esNocturno: session.esNocturno,
    codigoPromoUsado: session.codigoPromo,
    estado: "pendiente",
  });
  session.step = "esperando_chofer";
  session.choferId = chofer.wialonId;
  session.choferPhone = chofer.phone;
  session.choferNombre = chofer.nombre;
  session.choferPlaca = chofer.placa;
  session.viajeId = viaje._id.toString();
  if (session.codigoPromoId) {
    await CodigoPromo.findByIdAndUpdate(session.codigoPromoId, { usado: true, fechaUso: new Date() });
  }
  const linkRuta = generarLinkRutaCompleta(session.origen, session.paradas || [], session.destino);
  let textoParadas = "";
  if (session.paradas?.length) {
    textoParadas = "\n";
    session.paradas.forEach((p, i) => {
      textoParadas += `⏸️ Parada ${i+1}: ${p.nombre || 'Ver mapa'}\n`;
    });
  }
  const textoObs = session.observaciones ? `\n📝 *Observaciones:*\n"${session.observaciones}"\n` : "";
  const emoji = session.tipoVehiculo === "moto" ? "🏍️" : "🚗";
  await enviarBotones(chofer.phone,
    `${emoji} *NUEVO VIAJE EN ${session.tipoVehiculo.toUpperCase()}*\n\n` +
    `📏 Distancia total: ${session.distancia} km\n` +
    `💰 Precio: Bs ${session.precio}\n` +
    (session.esNocturno ? `🌙 Incluye recargo nocturno (+15%)\n` : ``) +
    `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
    `📍 Origen: ${session.origen.nombre || 'Ver mapa'}\n` +
    textoParadas +
    `🏁 Destino: ${session.destino.nombre || 'Ver mapa'}\n` +
    textoObs +
    `\n⚠️ Espera >5min en parada: +Bs 2/min\n\n` +
    `🗺️ Ruta:\n${linkRuta}`,
    [
      { id: "aceptar_viaje", title: "✅ Aceptar" },
      { id: "rechazar_viaje", title: "❌ Rechazar" },
    ]
  );
  await enviarMensaje(userPhone, `🔍 Encontramos un ${session.tipoVehiculo} cerca.\nEsperando confirmación...`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE LLEGADA
// ═══════════════════════════════════════════════════════════════════════════

setInterval(async () => {
  const enCurso = Object.entries(sessions).filter(([, s]) => s.step === "en_curso");
  for (const [userPhone, session] of enCurso) {
    try {
      const posChofer = await obtenerUbicacionChofer(session.choferId);
      const distDestino = distanciaEntrePuntos(
        posChofer.lat, posChofer.lng,
        session.destino.lat, session.destino.lng
      );
      if (distDestino < 0.2 && !session.llegadaNotificada) {
        session.llegadaNotificada = true;
        const chofer = await Chofer.findOne({ wialonId: session.choferId });
        if (chofer) {
          await enviarBotones(chofer.phone,
            "📍 Parece que llegaste al destino. ¿Finalizas?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
          );
          await enviarMensaje(userPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      }
    } catch { }
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function procesarMensajeChofer(phone, mensajeTexto, buttonId) {
  let chofer = await Chofer.findOne({ phone });

  // Registro
  if (!chofer) {
    if (!sessions[phone]) sessions[phone] = { step: "chofer_terminos" };
    const session = sessions[phone];

    if (session.step === "chofer_terminos") {
      await enviarBotones(phone,
        `👋 ¡Bienvenido a *ChatGo* de RastreoPlus!\n\n` +
        `Términos para Conductores:\n\n` +
        `• Eres contratista independiente\n` +
        `• Mantén WiaTag activo con GPS\n` +
        `• Licencia, SOAT e ITV vigentes\n` +
        `• Trato cordial y profesional\n` +
        `• Pago diario de Bs 10\n` +
        `• Prohibido celular conduciendo`,
        [
          { id: "chofer_acepta_tc", title: "✅ Acepto" },
          { id: "chofer_rechaza_tc", title: "❌ No acepto" },
        ]
      );
      session.step = "chofer_esperando_tc";
      return;
    }

    if (session.step === "chofer_esperando_tc") {
      if (buttonId === "chofer_acepta_tc") {
        session.step = "chofer_tipo_vehiculo";
        await enviarBotones(phone,
          "✅ Términos aceptados.\n\n¿Qué vehículo manejas?",
          [
            { id: "chofer_tipo_auto", title: "🚗 Auto" },
            { id: "chofer_tipo_moto", title: "🏍️ Moto" },
          ]
        );
      } else {
        delete sessions[phone];
        await enviarMensaje(phone, "Debes aceptar los términos para usar ChatGo.");
      }
      return;
    }

    if (session.step === "chofer_tipo_vehiculo") {
      if (buttonId === "chofer_tipo_auto") session.tipoVehiculo = "auto";
      else if (buttonId === "chofer_tipo_moto") session.tipoVehiculo = "moto";
      else { await enviarMensaje(phone, "Elige Auto o Moto."); return; }
      session.step = "chofer_registro_wialonid";
      await enviarMensaje(phone, "Perfecto. Envía tu *ID de Wialon* (solo el número):");
      return;
    }

    if (session.step === "chofer_registro_wialonid") {
      session.wialonId = mensajeTexto.trim();
      session.step = "chofer_registro_placa";
      await enviarMensaje(phone, "Ahora tu *número de placa*:");
      return;
    }

    if (session.step === "chofer_registro_placa") {
      session.placa = mensajeTexto.trim().toUpperCase();
      session.step = "chofer_registro_nombre";
      await enviarMensaje(phone, "Tu *nombre completo*:");
      return;
    }

    if (session.step === "chofer_registro_nombre") {
      const nuevo = await Chofer.create({
        phone, wialonId: session.wialonId, placa: session.placa,
        nombre: mensajeTexto.trim(), tipoVehiculo: session.tipoVehiculo,
        estado: "offline", aceptoTerminos: true,
      });
      delete sessions[phone];
      const emoji = nuevo.tipoVehiculo === "moto" ? "🏍️" : "🚗";
      await enviarBotones(phone,
        `✅ *Registro exitoso!*\n\n👤 ${nuevo.nombre}\n${emoji} ${nuevo.tipoVehiculo.toUpperCase()}\n🔢 Placa: ${nuevo.placa}\n\nPara iniciar tu jornada:`,
        [
          { id: "chofer_libre", title: "🟢 Iniciar jornada" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }
    return;
  }

  // Botones
  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "esperando_chofer" && s.choferId === chofer.wialonId);
      if (!entry) return enviarMensaje(phone, "No tienes viajes pendientes.");
      const [userPhone, session] = entry;
      chofer.estado = "ocupado";
      await chofer.save();
      await Viaje.findByIdAndUpdate(session.viajeId, { estado: "en_camino" });
      session.step = "chofer_en_camino";
      const linkRastreo = await generarLinkLocator(chofer.wialonId);
      const emoji = chofer.tipoVehiculo === "moto" ? "🏍️" : "🚗";
      await enviarMensaje(userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
        `👤 Chofer: ${chofer.nombre}\n` +
        `${emoji} ${chofer.tipoVehiculo.toUpperCase()} - Placa: ${chofer.placa}\n` +
        `⭐ Calificación: ${chofer.promedioCalificacion?.toFixed(1) || '5.0'}\n\n` +
        `📍 Rastrea:\n${linkRastreo}\n\n` +
        `🆘 En emergencia escribe "SOS"\n` +
        `💬 Escribe cualquier mensaje para chatear.`
      );
      await enviarBotones(phone,
        `✅ Viaje aceptado!\n\nCuando llegues al pasajero:`,
        [
          { id: "llegue_al_punto", title: "🚕 Llegué" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "rechazar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "esperando_chofer" && s.choferId === chofer.wialonId);
      if (entry) {
        const [userPhone, session] = entry;
        session.choferId = null;
        session.step = "confirmado";
        await enviarMensaje(userPhone, "⏳ Buscando otro chofer...");
        await asignarChofer(userPhone, session);
      }
      return;
    }

    if (buttonId === "llegue_al_punto") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "chofer_en_camino" && s.choferId === chofer.wialonId);
      if (!entry) return enviarMensaje(phone, "No tienes viajes activos.");
      const [userPhone, session] = entry;
      session.step = "chofer_esperando_pasajero";
      await Viaje.findByIdAndUpdate(session.viajeId, { estado: "esperando_pasajero" });
      const emoji = chofer.tipoVehiculo === "moto" ? "🏍️" : "🚗";
      await enviarMensaje(userPhone,
        `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n${emoji} ${chofer.placa}\n\nDirígete al vehículo.`
      );
      await enviarBotones(phone,
        `✅ Pasajero notificado.\n\nCuando suba al vehículo:`,
        [
          { id: "iniciar_viaje", title: "▶️ Iniciar viaje" },
          { id: "cancelar_viaje_chofer", title: "❌ Cancelar" },
        ]
      );
      return;
    }

    if (buttonId === "iniciar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "chofer_esperando_pasajero" && s.choferId === chofer.wialonId);
      if (!entry) return enviarMensaje(phone, "No tienes viajes activos.");
      const [userPhone, session] = entry;
      session.step = "en_curso";
      session.paradaActual = 0;
      await Viaje.findByIdAndUpdate(session.viajeId, { estado: "en_curso" });
      await enviarMensaje(userPhone, `🚖 *Viaje iniciado*\n\n¡Disfruta tu viaje con ChatGo!\n🆘 Escribe SOS en emergencia.`);
      const linkRuta = generarLinkRutaCompleta(session.origen, session.paradas || [], session.destino);
      let mensajeChofer = `▶️ *Viaje iniciado*\n\n`;
      let botones = [];
      if (session.paradas?.length > 0) {
        mensajeChofer += `📍 Siguiente parada: ${session.paradas[0].nombre || 'Ver mapa'}\n` +
          `🏁 Destino final: ${session.destino.nombre || 'Ver mapa'}\n\n` +
          `🗺️ Ruta:\n${linkRuta}`;
        botones = [{ id: "llegue_a_parada", title: "🚏 Llegué a parada" }];
      } else {
        mensajeChofer += `🏁 Destino: ${session.destino.nombre || 'Ver mapa'}\n📏 ${session.distancia} km\n\n🗺️ Ruta:\n${linkRuta}`;
        botones = [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }];
      }
      await enviarBotones(phone, mensajeChofer, botones);
      return;
    }

    if (buttonId === "llegue_a_parada") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "en_curso" && s.choferId === chofer.wialonId);
      if (!entry) return;
      const [userPhone, session] = entry;
      const idx = session.paradaActual || 0;
      session.tiempoLlegadaParada = Date.now();
      session.parandoEsperando = true;
      await enviarMensaje(userPhone,
        `🚏 Tu chofer llegó a la parada ${idx + 1}.\n⏱️ ${CONFIG.ESPERA_LIBRE_MIN} minutos sin cobro extra.`
      );
      await enviarBotones(phone,
        `🚏 En parada ${idx + 1}.\n\n⏱️ Tiempo libre: ${CONFIG.ESPERA_LIBRE_MIN} min\nDespués: +Bs ${CONFIG.COBRO_ESPERA_BS_MIN}/min`,
        [{ id: "continuar_viaje", title: "▶️ Continuar" }]
      );
      return;
    }

    if (buttonId === "continuar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        s.step === "en_curso" && s.choferId === chofer.wialonId);
      if (!entry) return;
      const [userPhone, session] = entry;
      const idx = session.paradaActual || 0;
      const tiempoEsperaMs = Date.now() - (session.tiempoLlegadaParada || Date.now());
      const tiempoEsperaMin = Math.round(tiempoEsperaMs / 60000);
      const tiempoExtra = Math.max(0, tiempoEsperaMin - CONFIG.ESPERA_LIBRE_MIN);
      const cobroExtra = tiempoExtra * CONFIG.COBRO_ESPERA_BS_MIN;
      if (cobroExtra > 0) {
        session.precioExtraEspera = (session.precioExtraEspera || 0) + cobroExtra;
        session.precio += cobroExtra;
        await enviarMensaje(userPhone,
          `⏱️ Esperaste ${tiempoEsperaMin} min en parada.\nCobro extra: +Bs ${cobroExtra}\n💰 Nuevo total: Bs ${session.precio}`
        );
      }
      session.parandoEsperando = false;
      session.paradaActual = idx + 1;
      const paradas = session.paradas || [];
      if (paradas[idx]) paradas[idx].tiempoEsperaMin = tiempoEsperaMin;
      await Viaje.findByIdAndUpdate(session.viajeId, {
        paradas, precioExtraEspera: session.precioExtraEspera, precioTotal: session.precio,
      });
      const linkRuta = generarLinkRutaCompleta(session.origen, paradas, session.destino);
      if (session.paradaActual < paradas.length) {
        const sig = paradas[session.paradaActual];
        await enviarBotones(phone,
          `▶️ Continuando\n\n📍 Siguiente: Parada ${session.paradaActual + 1}\n${sig.nombre || 'Ver mapa'}\n\n🗺️ ${linkRuta}`,
          [{ id: "llegue_a_parada", title: "🚏 Llegué a parada" }]
        );
      } else {
        await enviarBotones(phone,
          `▶️ Continuando al destino final\n\n🏁 ${session.destino.nombre || 'Ver mapa'}\n\n🗺️ ${linkRuta}`,
          [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
        );
      }
      return;
    }

    if (buttonId === "cancelar_viaje_chofer") {
      const entry = Object.entries(sessions).find(([, s]) =>
        (s.step === "chofer_en_camino" || s.step === "chofer_esperando_pasajero") &&
        s.choferId === chofer.wialonId);
      if (entry) {
        const [userPhone] = entry;
        await enviarBotones(phone,
          `❌ ¿Por qué cancelas?`,
          [
            { id: `cancel_motivo_trafico_${userPhone}`, title: "🚧 Tráfico" },
            { id: `cancel_motivo_personal_${userPhone}`, title: "🤒 Personal" },
            { id: `cancel_motivo_otro_${userPhone}`, title: "❓ Otro" },
          ]
        );
      }
      return;
    }

    if (buttonId.startsWith("cancel_motivo_")) {
      const partes = buttonId.replace("cancel_motivo_", "").split("_");
      const motivo = partes[0];
      const userPhone = partes.slice(1).join("_");
      const session = sessions[userPhone];
      if (!session) return;
      const motivoTexto = { trafico: "Tráfico/Demora", personal: "Problema personal", otro: "Otro motivo" }[motivo] || "Otro";
      await Viaje.findByIdAndUpdate(session.viajeId, {
        estado: "cancelado_chofer", cancelado: true, motivoCancelacion: motivoTexto,
      });
      await Chofer.findOneAndUpdate({ phone }, { $inc: { cancelacionesTotal: 1 } });
      chofer.estado = "libre";
      await chofer.save();
      await enviarMensaje(userPhone, `❌ Tu chofer canceló (${motivoTexto}).\nPuedes pedir otro cuando quieras. 🚖`);
      await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
      delete sessions[userPhone];
      return;
    }

    if (buttonId === "terminar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        (s.step === "en_curso" || s.step === "chofer_esperando_pasajero") &&
        s.choferId === chofer.wialonId);
      if (!entry) return;
      const [userPhone, session] = entry;
      await Viaje.findByIdAndUpdate(session.viajeId, {
        estado: "completado", fechaFin: new Date(),
        precioTotal: session.precio, precioExtraEspera: session.precioExtraEspera || 0,
      });
      await Usuario.findOneAndUpdate({ phone: userPhone }, { $inc: { viajesTotal: 1 } });
      await guardarRutaFrecuente(userPhone, session.origen, session.destino);
      await enviarBotones(phone,
        `🏁 Viaje finalizado!\n\n💰 Total: Bs ${session.precio}\n\n¿Recibiste el pago?`,
        [
          { id: `pago_recibido_${userPhone}`, title: "✅ Recibí pago" },
          { id: `pago_no_recibido_${userPhone}`, title: "❌ No pagó" },
        ]
      );
      await enviarBotones(userPhone,
        `✅ *Viaje completado*\n\n📏 ${session.distancia} km\n💰 Bs ${session.precio}\n\n⭐ ¿Cómo califica el viaje?`,
        [
          { id: `calif_5_${session.viajeId}`, title: "⭐⭐⭐⭐⭐ 5" },
          { id: `calif_4_${session.viajeId}`, title: "⭐⭐⭐⭐ 4" },
          { id: `calif_menos_${session.viajeId}`, title: "⭐ Menos" },
        ]
      );
      session.step = "calificando";
      return;
    }

    if (buttonId.startsWith("pago_recibido_")) {
      const userPhone = buttonId.replace("pago_recibido_", "");
      const session = sessions[userPhone];
      if (session) {
        await Viaje.findByIdAndUpdate(session.viajeId, { pagado: true });
        await Chofer.findOneAndUpdate({ phone }, { estado: "libre", $inc: { viajesTotal: 1 } });
        await enviarBotones(phone,
          `✅ ¡Excelente!\n🟢 Ya estás LIBRE.`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
      }
      return;
    }

    if (buttonId.startsWith("pago_no_recibido_")) {
      const userPhone = buttonId.replace("pago_no_recibido_", "");
      const session = sessions[userPhone];
      if (session) {
        await Viaje.findByIdAndUpdate(session.viajeId, { pagado: false });
        await Chofer.findOneAndUpdate({ phone }, { estado: "libre", $inc: { viajesTotal: 1 } });
        await enviarMensaje(CONFIG.ADMIN_PHONE,
          `⚠️ *Pasajero no pagó*\n\nChofer: ${chofer.nombre}\nPasajero: +${userPhone}\nViaje: Bs ${session.precio}\nOrigen: ${session.origen.nombre || 'N/A'}\nDestino: ${session.destino.nombre || 'N/A'}`
        );
        await enviarBotones(phone,
          `❌ Reportado al admin.\n🟢 Ya estás LIBRE.`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
      }
      return;
    }

    if (buttonId === "chofer_libre") {
      const hoy = new Date();
      const yaPageHoy = chofer.pagoDiario?.aprobado &&
        chofer.pagoDiario?.fecha &&
        new Date(chofer.pagoDiario.fecha).toDateString() === hoy.toDateString();
      if (!yaPageHoy) {
        chofer.estado = "offline";
        await chofer.save();
        await enviarMensaje(phone, `Para estar LIBRE primero paga tu cuota diaria de *Bs 10*.`);
        await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame la *foto del comprobante*.`);
        sessions[phone] = { step: "chofer_esperando_comprobante" };
        return;
      }
      chofer.estado = "libre";
      await chofer.save();
      await enviarBotones(phone,
        `✅ Ya estás *LIBRE* y listo! 🚖\n⭐ Calificación: ${chofer.promedioCalificacion?.toFixed(1) || '5.0'}`,
        [
          { id: "chofer_ocupado", title: "🔴 Ocupado" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }

    if (buttonId === "chofer_ocupado") {
      chofer.estado = "ocupado";
      await chofer.save();
      await enviarBotones(phone, `🔴 Estado: *OCUPADO*`,
        [
          { id: "chofer_libre", title: "🟢 Libre" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }

    if (buttonId === "chofer_ayuda") {
      const totalCalif = chofer.calificaciones?.length || 0;
      await enviarMensaje(phone,
        `❓ *Ayuda ChatGo*\n\n` +
        `🟢 Libre → Recibes viajes\n🔴 Ocupado → No recibes\n` +
        `🆘 SOS → En emergencia escribe "SOS"\n💬 Antes de iniciar puedes chatear con el pasajero\n\n` +
        `📊 *Tus stats:*\nViajes: ${chofer.viajesTotal}\nCalificación: ${chofer.promedioCalificacion?.toFixed(1) || '5.0'} (${totalCalif} viajes)\n\n` +
        `Para soporte contáctanos al admin.`
      );
      return;
    }

    if (buttonId.startsWith("aprobar_pago_")) {
      const choferPhone = buttonId.replace("aprobar_pago_", "");
      await Chofer.findOneAndUpdate({ phone: choferPhone }, {
        "pagoDiario.aprobado": true, "pagoDiario.fecha": new Date(), estado: "libre",
      });
      await enviarBotones(choferPhone,
        `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`,
        [
          { id: "chofer_ocupado", title: "🔴 Ocupado" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
      return;
    }
  }

  // SOS
  if (mensajeTexto && mensajeTexto.toUpperCase().includes("SOS")) {
    const entry = Object.entries(sessions).find(([, s]) =>
      (s.step === "en_curso" || s.step === "chofer_en_camino" || s.step === "chofer_esperando_pasajero") &&
      s.choferId === chofer.wialonId);
    if (entry) {
      const [userPhone, session] = entry;
      await Viaje.findByIdAndUpdate(session.viajeId, { sosActivado: true });
      try {
        const pos = await obtenerUbicacionChofer(chofer.wialonId);
        const linkUbic = `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
        await enviarMensaje(CONFIG.ADMIN_PHONE,
          `🆘 *SOS DEL CHOFER*\n\n👤 ${chofer.nombre}\n📞 +${phone}\n🚗 ${chofer.placa}\n📍 ${linkUbic}\n🧍 Pasajero: +${userPhone}\n\n⚠️ ATENCIÓN INMEDIATA`
        );
        await enviarMensaje(userPhone,
          `🆘 *Alerta de seguridad*\n\nTu chofer activó el SOS. Hemos notificado al equipo.\nMantén la calma. Si tú también necesitas ayuda escribe "SOS".`
        );
        await enviarMensaje(phone,
          `🆘 SOS activado.\nHemos notificado al admin con tu ubicación.\n📞 Llama al 110 si es emergencia grave.`
        );
      } catch (e) { console.error("[SOS]", e.message); }
    } else {
      await enviarMensaje(phone, "Solo puedes activar SOS durante un viaje activo.");
    }
    return;
  }

  // Comprobante
  if (sessions[phone]?.step === "chofer_esperando_comprobante") {
    chofer.pagoDiario = { fecha: new Date(), pagado: true, aprobado: false };
    await chofer.save();
    delete sessions[phone];
    await enviarBotones(CONFIG.ADMIN_PHONE,
      `💰 *Comprobante recibido*\n\n👤 ${chofer.nombre}\n🚗 ${chofer.placa}\n📞 +${phone}`,
      [{ id: `aprobar_pago_${phone}`, title: "✅ Aprobar" }]
    );
    await enviarMensaje(phone, "⏳ Comprobante recibido. Esperando aprobación...");
    return;
  }

  // Chat con pasajero
  const viajeEspera = Object.entries(sessions).find(([, s]) =>
    (s.step === "chofer_en_camino" || s.step === "chofer_esperando_pasajero") &&
    s.choferId === chofer.wialonId);
  if (viajeEspera && mensajeTexto && mensajeTexto.trim()) {
    const [userPhone] = viajeEspera;
    await enviarMensaje(userPhone, `💬 *Mensaje de tu chofer:*\n${mensajeTexto.trim()}`);
    await enviarMensaje(phone, "✅ Enviado al pasajero");
    return;
  }

  // Menú default
  const hoy = new Date();
  const yaPageHoy = chofer.pagoDiario?.aprobado &&
    chofer.pagoDiario?.fecha &&
    new Date(chofer.pagoDiario.fecha).toDateString() === hoy.toDateString();
  if (!yaPageHoy) {
    chofer.estado = "offline";
    await chofer.save();
    await enviarMensaje(phone, `👋 Hola ${chofer.nombre}!\n\nPara iniciar tu jornada paga *Bs 10*.`);
    await enviarImagen(phone, CONFIG.QR_IMAGE_URL, `📲 Escanea el QR y envíame el *comprobante*.`);
    sessions[phone] = { step: "chofer_esperando_comprobante" };
    return;
  }
  if (chofer.estado === "libre") {
    await enviarBotones(phone,
      `👋 Hola ${chofer.nombre}!\n🟢 Estás *LIBRE*.\n⭐ Calificación: ${chofer.promedioCalificacion?.toFixed(1) || '5.0'}`,
      [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  } else {
    await enviarBotones(phone,
      `👋 Hola ${chofer.nombre}!\n${chofer.estado === "ocupado" ? "🔴 Estás *OCUPADO*" : "⚪ Estás desconectado"}`,
      [
        { id: "chofer_libre", title: "🟢 Libre" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// USUARIO
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCalculoViaje(phone, session) {
  session.step = "calculando";
  await enviarMensaje(phone, "⏳ Calculando ruta y precio...");
  try {
    const { km } = await calcularDistanciaConParadas(session.origen, session.paradas || [], session.destino);
    const precioCalc = calcularPrecio(km, session.tipoVehiculo);
    session.distancia = km;
    session.precio = precioCalc.total;
    session.precioBase = precioCalc.base;
    session.recargoNocturno = precioCalc.recargoNocturno;
    session.precioPorKm = precioCalc.precioPorKm;
    session.esNocturno = precioCalc.nocturno;
    
    const usuario = await Usuario.findOne({ phone });
    const tieneCodigos = await CodigoPromo.findOne({
      asignadoAPhone: phone, usado: false, vencimiento: { $gt: new Date() }
    });
    
    if (tieneCodigos) {
      session.step = "preguntar_codigo_promo";
      await enviarBotones(phone,
        `💰 *Precio: Bs ${session.precio}*\n${session.esNocturno ? `🌙 Incluye recargo nocturno (+15%)\n` : ''}\n¿Tienes un código de descuento?`,
        [
          { id: "usar_codigo", title: "🎁 Sí, tengo" },
          { id: "no_codigo", title: "Continuar" },
        ]
      );
    } else {
      await mostrarResumenViaje(phone, session);
    }
  } catch (e) {
    console.error("[CALCULO]", e.message);
    await enviarMensaje(phone, "❌ Error calculando. Intenta de nuevo.");
    session.step = "esperando_origen";
  }
}

async function mostrarResumenViaje(phone, session) {
  let textoParadas = "";
  if (session.paradas?.length) {
    textoParadas = "\n";
    session.paradas.forEach((p, i) => {
      textoParadas += `⏸️ Parada ${i+1}: ${p.nombre || 'Tu parada'}\n`;
    });
  }
  const textoObs = session.observaciones ? `\n📝 Notas: "${session.observaciones}"\n` : "";
  const textoNoct = session.esNocturno ? `🌙 Recargo nocturno: +Bs ${session.recargoNocturno}\n` : "";
  const textoDesc = session.descuento ? `🎁 Descuento: -Bs ${session.descuento}\n` : "";
  const emoji = session.tipoVehiculo === "moto" ? "🏍️" : "🚗";
  await enviarBotones(phone,
    `🗺️ *Resumen del viaje*\n\n` +
    `${emoji} Tipo: ${session.tipoVehiculo.toUpperCase()}\n` +
    `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n` +
    textoParadas +
    `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n` +
    textoObs +
    `\n📏 Distancia: ${session.distancia} km\n` +
    textoNoct +
    textoDesc +
    `💰 *Total: Bs ${session.precio}*\n\n` +
    `⚠️ Espera >5min en parada: +Bs 2/min\n\n¿Confirmas?`,
    [
      { id: "confirmar_viaje", title: "✅ Confirmar" },
      { id: "cancelar_viaje", title: "❌ Cancelar" },
    ]
  );
  session.step = "esperando_confirmacion";
}

async function procesarMensajeUsuario(phone, mensaje, buttonId) {
  let usuario = await Usuario.findOne({ phone });

  // Bloqueo
  if (usuario?.bloqueadoHasta && usuario.bloqueadoHasta > new Date()) {
    const min = Math.ceil((usuario.bloqueadoHasta - new Date()) / 60000);
    await enviarMensaje(phone, `⛔ Estás bloqueado por exceso de cancelaciones.\nEspera ${min} minutos.`);
    return;
  }

  const texto = mensaje.text?.body?.trim() || "";

  // Comandos
  if (texto.toLowerCase().includes("mis viajes") || texto.toLowerCase() === "historial") {
    const viajes = await Viaje.find({ usuarioPhone: phone, estado: "completado" })
      .sort({ fechaFin: -1 }).limit(5);
    if (!viajes.length) {
      await enviarMensaje(phone, "📜 Aún no tienes viajes completados.");
      return;
    }
    let textoHist = "📜 *Tus últimos viajes:*\n\n";
    viajes.forEach((v, i) => {
      const fecha = v.fechaFin?.toLocaleDateString('es-BO') || 'N/A';
      const emoji = v.tipoVehiculo === "moto" ? "🏍️" : "🚗";
      textoHist += `${i+1}. ${fecha} - ${emoji}\n   📍 ${v.origen?.nombre || '?'} → ${v.destino?.nombre || '?'}\n   💰 Bs ${v.precioTotal} (${v.distanciaKm} km)\n\n`;
    });
    await enviarMensaje(phone, textoHist);
    return;
  }

  if (texto.toLowerCase().includes("mi codigo") || texto.toLowerCase().includes("mi código")) {
    if (!usuario?.codigoReferido) {
      const nuevoCodigo = generarCodigoPromo(phone);
      await Usuario.findOneAndUpdate({ phone }, { codigoReferido: nuevoCodigo });
      await enviarMensaje(phone,
        `🎁 *Tu código de invitación:*\n\n*${nuevoCodigo}*\n\nCompártelo con amigos. Cuando lo usen:\n✅ Tu amigo: 40% descuento\n✅ Tú: ganas un código nuevo\n\n*Recomienda y ahorra!* 🚖`
      );
    } else {
      await enviarMensaje(phone, `🎁 *Tu código:* ${usuario.codigoReferido}\n\n¡40% de descuento al usar!`);
    }
    return;
  }

  // SOS
  if (texto.toUpperCase().includes("SOS") && sessions[phone]?.choferPhone) {
    const session = sessions[phone];
    await Viaje.findByIdAndUpdate(session.viajeId, { sosActivado: true });
    try {
      const pos = await obtenerUbicacionChofer(session.choferId);
      const linkUbic = `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
      await enviarMensaje(CONFIG.ADMIN_PHONE,
        `🆘 *SOS DEL PASAJERO*\n\n📞 Pasajero: +${phone}\n👤 Chofer: ${session.choferNombre || 'N/A'}\n📞 +${session.choferPhone}\n🚗 Placa: ${session.choferPlaca || 'N/A'}\n📍 ${linkUbic}\n\n⚠️ ATENCIÓN INMEDIATA`
      );
      await enviarMensaje(session.choferPhone,
        `🆘 *Alerta de seguridad*\n\nEl pasajero activó el SOS. Hemos notificado al equipo.\nConduce con seguridad.`
      );
      await enviarMensaje(phone,
        `🆘 SOS activado. Notificamos al equipo.\n📞 Si es emergencia grave llama al 110.`
      );
    } catch (e) { console.error("[SOS]", e.message); }
    return;
  }

  // Términos
  if (!usuario || !usuario.aceptoTerminos) {
    if (!sessions[phone]) sessions[phone] = { step: "usuario_terminos" };
    const session = sessions[phone];

    if (session.step === "usuario_terminos" && !buttonId) {
      await enviarBotones(phone,
        `👋 ¡Bienvenido a *ChatGo*!\n\n¿Cómo quieres usar la plataforma?`,
        [
          { id: "soy_pasajero", title: "🧍 Pasajero" },
          { id: "soy_chofer", title: "🚖 Chofer" },
        ]
      );
      session.step = "eligiendo_rol";
      return;
    }

    if (session.step === "eligiendo_rol") {
      if (buttonId === "soy_chofer") {
        delete sessions[phone];
        await procesarMensajeChofer(phone, "", null);
        return;
      }
      session.step = "usuario_terminos";
    }

    if (session.step === "usuario_terminos" || buttonId === "soy_pasajero") {
      await enviarBotones(phone,
        `👋 Bienvenido a *ChatGo* de RastreoPlus.\n\nTérminos:\n• ChatGo es intermediación tecnológica\n• Tu GPS solo se usa para el viaje\n• No compartimos info con terceros\n• Pago directo al conductor\n• Jurisdicción: Cochabamba, Bolivia\n\n¿Aceptas?`,
        [
          { id: "usuario_acepta_tc", title: "✅ Acepto" },
          { id: "usuario_rechaza_tc", title: "❌ No acepto" },
        ]
      );
      session.step = "usuario_esperando_tc";
      return;
    }

    if (session.step === "usuario_esperando_tc") {
      if (buttonId === "usuario_acepta_tc") {
        const codigoNuevo = generarCodigoPromo(phone);
        usuario = await Usuario.create({ phone, aceptoTerminos: true, codigoReferido: codigoNuevo });
        delete sessions[phone];
        await enviarMensaje(phone,
          `✅ ¡Bienvenido a ChatGo!\n\nPara pedir taxi escribe cualquier mensaje o envía un audio.\n\n🎁 Tu código: *${codigoNuevo}*\nCompártelo con amigos para ganar promos.\n\n📜 "mis viajes" → historial\n🆘 "SOS" → emergencia durante viaje\n\n🚖 ¡A pedir taxis!`
        );
      } else {
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos.");
        delete sessions[phone];
      }
      return;
    }
  }

  if (!sessions[phone]) sessions[phone] = { step: "inicio" };
  const session = sessions[phone];

  // Coords
  let coords = null;
  if (mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon);
    if (!isNaN(lat) && !isNaN(lng)) {
      coords = { lat, lng };
      console.log(`[UBICACION] ${phone}: lat=${lat}, lng=${lng}`);
    }
  }

  // Chat con chofer
  if (texto && !buttonId &&
      (session.step === "esperando_chofer" || session.step === "chofer_en_camino" || session.step === "chofer_esperando_pasajero")) {
    if (session.choferPhone) {
      await enviarMensaje(session.choferPhone, `💬 *Mensaje del pasajero:*\n${texto}`);
      await enviarMensaje(phone, "✅ Enviado al chofer");
    }
    return;
  }

  // Audio
  if (mensaje.type === "audio" || mensaje.type === "voice") {
    await enviarMensaje(phone, "🎤 Procesando tu mensaje de voz...");
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      await enviarMensaje(phone, `🎤 Escuché: _"${transcripcion}"_`);
      const ubicaciones = await extraerUbicaciones(transcripcion);
      if (ubicaciones.observaciones) session.observaciones = ubicaciones.observaciones;
      if (!ubicaciones.origen && !ubicaciones.destino) {
        session.step = "esperando_tipo_vehiculo_inicial";
        await enviarBotones(phone, "No pude identificar lugares.\n\n¿Qué vehículo prefieres?",
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
        return;
      }
      if (ubicaciones.paradas?.length) {
        const paradasCoords = [];
        for (const p of ubicaciones.paradas.slice(0, CONFIG.MAX_PARADAS)) {
          const c = await geocodificarDireccion(p);
          if (c) { c.nombre = p; paradasCoords.push(c); }
        }
        if (paradasCoords.length) session.paradas = paradasCoords;
      }
      if (ubicaciones.origen) {
        const origenCoords = await geocodificarDireccion(ubicaciones.origen);
        if (origenCoords) {
          origenCoords.nombre = ubicaciones.origen;
          session.origen = origenCoords;
        }
      }
      if (ubicaciones.destino) {
        const destinoCoords = await geocodificarDireccion(ubicaciones.destino);
        if (destinoCoords) {
          destinoCoords.nombre = ubicaciones.destino;
          session.destino = destinoCoords;
        }
      }
      if (session.origen && session.destino) {
        session.step = "esperando_tipo_vehiculo";
        await enviarBotones(phone,
          `📍 Origen: ${session.origen.nombre}\n🏁 Destino: ${session.destino.nombre}\n` +
          (session.paradas?.length ? `⏸️ ${session.paradas.length} parada(s)\n` : "") +
          `\n¿Qué vehículo prefieres?`,
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
      } else if (session.origen) {
        session.step = "esperando_destino";
        await enviarMensaje(phone, `📍 Origen: ${session.origen.nombre}\n\n🏁 Envía tu *destino* (pin de WhatsApp).`);
      } else if (session.destino) {
        session.step = "esperando_origen";
        await enviarMensaje(phone, `🏁 Destino: ${session.destino.nombre}\n\n📍 Envía tu *origen* (pin de WhatsApp).`);
      }
    } catch (e) {
      console.error("[AUDIO]", e.message);
      await enviarMensaje(phone, "❌ Error procesando audio. Envía el pin de ubicación.");
      session.step = "esperando_origen";
    }
    return;
  }

  switch (session.step) {
    case "inicio": {
      const rutaFrec = await verificarRutaFrecuente(phone);
      if (rutaFrec) {
        session.rutaFrecuente = rutaFrec;
        session.step = "preguntando_ruta_frecuente";
        await enviarBotones(phone,
          `👋 ¡Hola!\n\n¿Vas al mismo lugar de siempre?\n\n📍 ${rutaFrec.origen.nombre || "Origen habitual"}\n🏁 ${rutaFrec.destino.nombre || "Destino habitual"}`,
          [
            { id: "usar_ruta_frecuente", title: "✅ Sí" },
            { id: "nueva_ruta", title: "📍 Nueva ruta" },
          ]
        );
      } else {
        session.step = "esperando_tipo_vehiculo_inicial";
        await enviarBotones(phone,
          `👋 ¡Hola! Bienvenido a *ChatGo*.\n\n¿Qué vehículo prefieres hoy?`,
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
      }
      break;
    }

    case "preguntando_ruta_frecuente":
      if (buttonId === "usar_ruta_frecuente") {
        session.origen = session.rutaFrecuente.origen;
        session.destino = session.rutaFrecuente.destino;
        session.step = "esperando_tipo_vehiculo";
        await enviarBotones(phone,
          `📍 ${session.origen.nombre}\n🏁 ${session.destino.nombre}\n\n¿Qué vehículo?`,
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
      } else {
        session.step = "esperando_tipo_vehiculo_inicial";
        await enviarBotones(phone,
          `¿Qué vehículo prefieres?`,
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
      }
      break;

    case "esperando_tipo_vehiculo_inicial":
      if (buttonId === "tipo_auto" || buttonId === "tipo_moto") {
        session.tipoVehiculo = buttonId === "tipo_moto" ? "moto" : "auto";
        session.step = "esperando_origen";
        await enviarMensaje(phone,
          `📍 Envía tu *ubicación de origen* con el pin de WhatsApp.\n\nTambién puedes enviar 🎤 audio diciendo a dónde vas.`
        );
      } else {
        await enviarMensaje(phone, "Por favor elige tipo de vehículo.");
      }
      break;

    case "esperando_tipo_vehiculo":
      if (buttonId === "tipo_auto" || buttonId === "tipo_moto") {
        session.tipoVehiculo = buttonId === "tipo_moto" ? "moto" : "auto";
        if (session.origen && session.destino) {
          session.step = "esperando_opciones";
          await enviarBotones(phone,
            `${session.tipoVehiculo === "moto" ? "🏍️" : "🚗"} ${session.tipoVehiculo.toUpperCase()}\n\n¿Quieres agregar algo?`,
            [
              { id: "agregar_parada", title: "➕ Parada" },
              { id: "agregar_observacion", title: "📝 Notas" },
              { id: "calcular_viaje", title: "✅ Calcular" },
            ]
          );
        } else if (!session.origen) {
          session.step = "esperando_origen";
          await enviarMensaje(phone, "📍 Envía tu *origen* con el pin.");
        } else {
          session.step = "esperando_destino";
          await enviarMensaje(phone, "🏁 Envía tu *destino* con el pin.");
        }
      }
      break;

    case "esperando_origen":
      if (!coords) {
        await enviarMensaje(phone, "📍 Envía tu *ubicación* con el pin de WhatsApp.");
        break;
      }
      session.origen = coords;
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) session.origen.nombre = dir;
      } catch {}
      if (!session.tipoVehiculo) {
        session.step = "esperando_tipo_vehiculo";
        await enviarBotones(phone, `✅ Origen recibido.\n\n¿Qué vehículo?`,
          [
            { id: "tipo_auto", title: "🚗 Auto" },
            { id: "tipo_moto", title: "🏍️ Moto" },
          ]
        );
      } else {
        session.step = "esperando_destino";
        await enviarMensaje(phone, "✅ Origen recibido.\n\n🏁 Envía tu *destino*.");
      }
      break;

    case "esperando_destino":
      if (!coords) {
        await enviarMensaje(phone, "🏁 Envía tu *destino* con el pin.");
        break;
      }
      session.destino = coords;
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) session.destino.nombre = dir;
      } catch {}
      session.step = "esperando_opciones";
      await enviarBotones(phone,
        `✅ Destino recibido.\n\n¿Quieres agregar algo?`,
        [
          { id: "agregar_parada", title: "➕ Parada" },
          { id: "agregar_observacion", title: "📝 Notas" },
          { id: "calcular_viaje", title: "✅ Calcular" },
        ]
      );
      break;

    case "esperando_opciones":
      if (buttonId === "agregar_parada") {
        if ((session.paradas?.length || 0) >= CONFIG.MAX_PARADAS) {
          await enviarMensaje(phone, `❌ Máximo ${CONFIG.MAX_PARADAS} paradas.`);
          return;
        }
        session.step = "esperando_parada";
        await enviarMensaje(phone,
          `📍 Envía la *ubicación de la parada* con el pin.\n(Parada ${(session.paradas?.length || 0) + 1} de ${CONFIG.MAX_PARADAS})`
        );
      } else if (buttonId === "agregar_observacion") {
        session.step = "esperando_observacion";
        await enviarMensaje(phone,
          `📝 *Escribe tus observaciones*\n\nEjemplos:\n• "Llevo mi perrito"\n• "Necesito parrilla"\n• "Voy con maleta grande"`
        );
      } else if (buttonId === "calcular_viaje") {
        await procesarCalculoViaje(phone, session);
      }
      break;

    case "esperando_parada":
      if (!coords) {
        await enviarMensaje(phone, "📍 Envía la *ubicación de la parada* con el pin.");
        break;
      }
      const paradaNueva = { lat: coords.lat, lng: coords.lng };
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) paradaNueva.nombre = dir;
      } catch {}
      if (!session.paradas) session.paradas = [];
      session.paradas.push(paradaNueva);
      session.step = "esperando_opciones";
      await enviarBotones(phone,
        `✅ Parada ${session.paradas.length} agregada.\n\n¿Algo más?`,
        [
          { id: "agregar_parada", title: "➕ Otra parada" },
          { id: "agregar_observacion", title: "📝 Notas" },
          { id: "calcular_viaje", title: "✅ Calcular" },
        ]
      );
      break;

    case "esperando_observacion":
      if (!texto) {
        await enviarMensaje(phone, "📝 Escribe tus observaciones.");
        break;
      }
      if (session.tipoVehiculo === "moto") {
        const razon = detectarIncompatibilidadMoto(texto);
        if (razon) {
          session.observacionPendiente = texto;
          session.step = "esperando_decision_moto";
          await enviarBotones(phone,
            `⚠️ *Atención*\n\nMencionaste algo relacionado con: *${razon}*\nEso no es compatible con MOTO.\n\n¿Qué prefieres?`,
            [
              { id: "cambiar_a_auto", title: "🚗 Cambiar a auto" },
              { id: "cancelar_viaje_moto", title: "❌ Cancelar" },
            ]
          );
          return;
        }
      }
      session.observaciones = texto;
      session.step = "esperando_opciones";
      await enviarBotones(phone,
        `✅ Notas: "${texto}"\n\n¿Algo más?`,
        [
          { id: "agregar_parada", title: "➕ Parada" },
          { id: "calcular_viaje", title: "✅ Calcular" },
        ]
      );
      break;

    case "esperando_decision_moto":
      if (buttonId === "cambiar_a_auto") {
        session.tipoVehiculo = "auto";
        session.observaciones = session.observacionPendiente;
        delete session.observacionPendiente;
        session.step = "esperando_opciones";
        await enviarBotones(phone,
          `✅ Cambiado a 🚗 AUTO\n\n¿Algo más?`,
          [
            { id: "agregar_parada", title: "➕ Parada" },
            { id: "calcular_viaje", title: "✅ Calcular" },
          ]
        );
      } else if (buttonId === "cancelar_viaje_moto") {
        delete sessions[phone];
        await enviarMensaje(phone, "❌ Viaje cancelado.");
      }
      break;

    case "preguntar_codigo_promo":
      if (buttonId === "usar_codigo") {
        session.step = "esperando_codigo";
        await enviarMensaje(phone, "🎁 Escribe tu código promocional:");
      } else {
        await mostrarResumenViaje(phone, session);
      }
      break;

    case "esperando_codigo":
      if (!texto) {
        await enviarMensaje(phone, "🎁 Escribe el código.");
        break;
      }
      const resultado = await aplicarCodigoPromo(texto, phone, session.precio);
      if (resultado.aplicado) {
        session.descuento = resultado.descuento;
        session.codigoPromo = texto.toUpperCase();
        session.codigoPromoId = resultado.promoId;
        session.precio -= resultado.descuento;
        await enviarMensaje(phone,
          `✅ Código aplicado!\n🎁 Descuento: -Bs ${resultado.descuento} (${resultado.porcentaje}%)\n💰 Nuevo precio: Bs ${session.precio}`
        );
      } else {
        await enviarMensaje(phone, `❌ ${resultado.mensaje}`);
      }
      await mostrarResumenViaje(phone, session);
      break;

    case "esperando_confirmacion":
      if (buttonId === "confirmar_viaje") {
        session.step = "confirmado";
        await enviarMensaje(phone, "✅ Viaje confirmado. Buscando chofer...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje") {
        const u = await Usuario.findOne({ phone });
        if (u) {
          const hoy = new Date().toDateString();
          const ultima = u.fechaUltimaCancelacion?.toDateString();
          if (hoy === ultima) u.cancelacionesHoy = (u.cancelacionesHoy || 0) + 1;
          else u.cancelacionesHoy = 1;
          u.fechaUltimaCancelacion = new Date();
          if (u.cancelacionesHoy >= CONFIG.CANCELACIONES_BLOQUEO) {
            const bloqueoHasta = new Date();
            bloqueoHasta.setMinutes(bloqueoHasta.getMinutes() + CONFIG.TIEMPO_BLOQUEO_MIN);
            u.bloqueadoHasta = bloqueoHasta;
            await enviarMensaje(phone,
              `⛔ Has cancelado ${CONFIG.CANCELACIONES_BLOQUEO} veces hoy.\nBloqueado por ${CONFIG.TIEMPO_BLOQUEO_MIN} minutos.`
            );
          }
          await u.save();
        }
        delete sessions[phone];
        await enviarMensaje(phone, "❌ Viaje cancelado.");
      }
      break;

    case "sin_chofer":
      if (buttonId === "confirmar_viaje_recordatorio") {
        await enviarMensaje(phone, "✅ Buscando chofer...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje") {
        delete sessions[phone];
        delete listaEspera[phone];
        await enviarMensaje(phone, "❌ Entendido. 🚖");
      }
      break;

    case "esperando_chofer":
      if (!buttonId) await enviarMensaje(phone, "⏳ Buscando tu chofer...");
      break;

    case "en_curso":
      if (!buttonId) await enviarMensaje(phone, "🚖 Viaje en curso. ¡Disfrútalo!\n🆘 Escribe SOS en emergencia.");
      break;

    case "calificando":
      if (buttonId?.startsWith("calif_")) {
        const partes = buttonId.split("_");
        const valor = partes[1];
        const viajeId = partes.slice(2).join("_");
        let estrellas;
        if (valor === "5") estrellas = 5;
        else if (valor === "4") estrellas = 4;
        else if (valor === "menos") {
          await enviarBotones(phone, `⭐ ¿Cuántas?`,
            [
              { id: `calif_3_${viajeId}`, title: "⭐⭐⭐ 3" },
              { id: `calif_2_${viajeId}`, title: "⭐⭐ 2" },
              { id: `calif_1_${viajeId}`, title: "⭐ 1" },
            ]
          );
          return;
        } else estrellas = parseInt(valor);
        await Viaje.findByIdAndUpdate(viajeId, { calificacionUsuario: estrellas });
        const viaje = await Viaje.findById(viajeId);
        if (viaje) {
          const choferActualizado = await Chofer.findOne({ phone: viaje.choferPhone });
          if (choferActualizado) {
            choferActualizado.calificaciones.push({ estrellas, fecha: new Date(), viajeId });
            const totalEstrellas = choferActualizado.calificaciones.reduce((s, c) => s + c.estrellas, 0);
            choferActualizado.promedioCalificacion = totalEstrellas / choferActualizado.calificaciones.length;
            await choferActualizado.save();
            const malas = choferActualizado.calificaciones.filter(c => c.estrellas <= 2).length;
            if (malas >= CONFIG.CALIFICACIONES_MALAS_LIMITE && !choferActualizado.notificadoMalCalificado) {
              await enviarMensaje(CONFIG.ADMIN_PHONE,
                `⚠️ *Chofer mal calificado*\n\n👤 ${choferActualizado.nombre}\n📞 +${choferActualizado.phone}\n🚗 ${choferActualizado.placa}\n⭐ Promedio: ${choferActualizado.promedioCalificacion.toFixed(1)}\n❌ ${malas} calificaciones bajas`
              );
              await enviarMensaje(choferActualizado.phone,
                `⚠️ *Aviso*\n\nHas recibido varias calificaciones bajas.\nMejora:\n• Trato cordial\n• Conducción segura\n• Vehículo limpio`
              );
              choferActualizado.notificadoMalCalificado = true;
              await choferActualizado.save();
            }
          }
        }
        if (estrellas >= 4) {
          // Generar nuevo código promo para que comparta
          const nuevoCodigo = await generarCodigoPromoUsuario(phone, phone);
          await enviarMensaje(phone,
            `⭐ ¡Gracias por tu calificación!\n\n🎁 *Te regalamos un código de descuento:*\n*${nuevoCodigo}*\n\n40% off en tu próximo viaje (válido 14 días).\n\nO compártelo con un amigo. 🚖`
          );
        } else {
          await enviarMensaje(phone, `⭐ Gracias por tu calificación.\n\nLamentamos que la experiencia no fuera buena. Tomaremos acción.\n\n🚖 ChatGo`);
        }
        delete sessions[phone];
      }
      break;

    default:
      delete sessions[phone];
      sessions[phone] = { step: "inicio" };
      await procesarMensajeUsuario(phone, mensaje, buttonId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === CONFIG.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    for (const msg of messages) {
      const phone = msg.from;
      const buttonId = msg.interactive?.button_reply?.id || null;
      const textoUpper = msg.text?.body?.trim().toUpperCase() || "";
      console.log(`[WEBHOOK] From: ${phone}, Type: ${msg.type}, Text: "${msg.text?.body || ""}"`);
      const esChofer = await Chofer.exists({ phone });
      const esRegistroChofer = textoUpper === "CHOFER" || textoUpper === "SOY CHOFER" || textoUpper === "CONDUCTOR" ||
        (sessions[phone] && sessions[phone].step?.startsWith("chofer_"));
      if (buttonId && buttonId.startsWith("aprobar_pago_") && phone === CONFIG.ADMIN_PHONE) {
        const choferPhone = buttonId.replace("aprobar_pago_", "");
        await Chofer.findOneAndUpdate({ phone: choferPhone }, {
          "pagoDiario.aprobado": true, "pagoDiario.fecha": new Date(), estado: "libre",
        });
        await enviarBotones(choferPhone,
          `✅ *Pago confirmado!*\n🚖 Ya estás LIBRE para recibir viajes.`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
        await enviarMensaje(phone, `✅ Pago aprobado para +${choferPhone}`);
        continue;
      }
      if (esChofer || esRegistroChofer) {
        await procesarMensajeChofer(phone, msg.text?.body || "", buttonId);
      } else {
        await procesarMensajeUsuario(phone, msg, buttonId);
      }
    }
  } catch (e) { console.error("[WEBHOOK] Error:", e.message); }
});

app.get("/unidades", async (req, res) => {
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
    });
    if (!resp.data.items) return res.json({ error: "Sin unidades" });
    const unidades = resp.data.items.map(u => ({
      id: u.id, nombre: u.nm, uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos ? {
        lat: u.pos.y, lng: u.pos.x,
        hace_min: Math.round((Date.now()/1000 - (u.pos.t || 0)) / 60),
      } : null,
    }));
    res.json({ total: unidades.length, unidades });
  } catch (e) { res.json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 ChatGo v3 corriendo en puerto ${PORT}`));
