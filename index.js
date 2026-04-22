// ═══════════════════════════════════════════════════════════════════════════
// ChatGo - Bot de Taxi por WhatsApp
// Lukmi S.R.L. - Cochabamba, Bolivia
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
  estado: { type: String, default: "offline" },
  pagoDiario: {
    fecha: Date,
    pagado: { type: Boolean, default: false },
    aprobado: { type: Boolean, default: false },
  },
  viajesTotal: { type: Number, default: 0 },
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
});

const viajeSchema = new mongoose.Schema({
  usuarioPhone: String,
  choferPhone: String,
  choferNombre: String,
  choferPlaca: String,
  origen: { lat: Number, lng: Number, nombre: String },
  destino: { lat: Number, lng: Number, nombre: String },
  distanciaKm: Number,
  precioTotal: Number,
  precioPorKm: Number,
  estado: { type: String, default: "pendiente" },
  fechaInicio: { type: Date, default: Date.now },
  fechaFin: Date,
});

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);

// ─── ESTADO EN MEMORIA ─────────────────────────────────────────────────────
const sessions = {};
const listaEspera = {};

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

function calcularPrecio(km) {
  let precioPorKm;
  if (km < 4) precioPorKm = 4.0;
  else if (km < 10) precioPorKm = 3.5;
  else precioPorKm = 2.5;
  const total = Math.round(Math.max(km * precioPorKm, 6));
  return { total, precioPorKm };
}

function distanciaEntrePuntos(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS
// ═══════════════════════════════════════════════════════════════════════════

async function calcularDistancia(origen, destino) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/distancematrix/json", {
      params: {
        origins: `${origen.lat},${origen.lng}`,
        destinations: `${destino.lat},${destino.lng}`,
        key: CONFIG.GOOGLE_MAPS_KEY,
        mode: "driving",
      },
    });

    if (res.data.status !== "OK") {
      console.error("[GOOGLE_MAPS] Status:", res.data.status, res.data.error_message);
      throw new Error("fallback");
    }

    const element = res.data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error("fallback");

    return {
      km: Math.round((element.distance.value / 1000) * 10) / 10,
      duracion: element.duration.text,
    };
  } catch (e) {
    const km = distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng);
    return { km: Math.round(km * 10) / 10, duracion: `~${Math.round(km * 3)} min` };
  }
}

async function geocodificarDireccion(direccion) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: `${direccion}, Cochabamba, Bolivia`,
        key: CONFIG.GOOGLE_MAPS_KEY,
      },
    });
    if (!res.data.results?.length) return null;
    const loc = res.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, nombre: res.data.results[0].formatted_address };
  } catch { return null; }
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

// ═══════════════════════════════════════════════════════════════════════════
// WIALON
// ═══════════════════════════════════════════════════════════════════════════

async function wialonLogin() {
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "token/login",
      params: JSON.stringify({ token: CONFIG.WIALON_TOKEN }),
    },
  });
  if (!res.data.eid) throw new Error("Wialon login failed");
  return res.data.eid;
}

async function obtenerUbicacionChofer(wialonId) {
  const eid = await wialonLogin();
  // Flag 1025 = flags básicos + posición. Usar 1 para info básica + 1024 para posición
  const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
    params: {
      svc: "core/search_item",
      params: JSON.stringify({ 
        id: parseInt(wialonId), 
        flags: 4294967295  // todos los flags para obtener todo
      }),
      sid: eid,
    },
  });
  
  const item = res.data.item;
  console.log(`[WIALON_RAW] Respuesta completa para ${wialonId}:`, JSON.stringify(item).substring(0, 500));
  
  if (!item) throw new Error("Unidad no encontrada en Wialon");
  if (!item.pos) {
    console.error(`[WIALON] Sin pos. Item keys:`, Object.keys(item));
    throw new Error("Sin GPS disponible");
  }
  
  const pos = item.pos;
  const minutos = Math.round((Date.now() / 1000 - (pos.t || 0)) / 60);
  
  // En Wialon: pos.y = latitud, pos.x = longitud
  console.log(`[WIALON] Chofer ${wialonId} (${item.nm || 'sin nombre'}): lat=${pos.y}, lng=${pos.x}, hace ${minutos}min`);
  
  return { lat: pos.y, lng: pos.x, minutos };
}

async function generarLinkLocator(wialonId) {
  try {
    const eid = await wialonLogin();
    const res = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "locator/create_hash",
        params: JSON.stringify({
          items: [parseInt(wialonId)],
          duration: 7200,
          type: 0,
        }),
        sid: eid,
      },
    });
    if (res.data?.hash) return `https://hosting.wialon.com/locator/index.html?t=${res.data.hash}`;
    throw new Error("No hash");
  } catch (e) {
    console.error("[LOCATOR] Error:", e.message);
    try {
      const pos = await obtenerUbicacionChofer(wialonId);
      return `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
    } catch { return "https://hosting.wialon.com/"; }
  }
}

async function buscarChoferDisponible(origenUsuario) {
  const choferes = await Chofer.find({ estado: "libre" });
  if (!choferes.length) return null;

  console.log(`[BUSCAR] Usuario: lat=${origenUsuario.lat}, lng=${origenUsuario.lng}`);
  console.log(`[BUSCAR] ${choferes.length} choferes libres`);

  let mejorChofer = null;
  let menorDist = Infinity;

  for (const chofer of choferes) {
    try {
      const pos = await obtenerUbicacionChofer(chofer.wialonId);
      const dist = distanciaEntrePuntos(origenUsuario.lat, origenUsuario.lng, pos.lat, pos.lng);
      console.log(`[BUSCAR] ${chofer.nombre}: ${dist.toFixed(2)}km`);
      if (dist < menorDist) {
        menorDist = dist;
        mejorChofer = { ...chofer.toObject(), ubicacion: pos, distanciaAlUsuario: dist };
      }
    } catch (e) {
      console.error(`[BUSCAR] Error chofer ${chofer.wialonId}:`, e.message);
    }
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
        content: `Extrae origen y destino de mensajes de taxi en Cochabamba, Bolivia.
Responde SOLO JSON: {"origen": "lugar", "destino": "lugar"}
Si no hay alguno, usa null.
La gente dice cosas como: "recógeme en X esquina Y", "llévame al Z". Extrae referencias completas.`,
      }, { role: "user", content: texto }],
      max_tokens: 150,
    }, { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` } });

    const content = res.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(content);
  } catch { return { origen: null, destino: null }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP META API
// ═══════════════════════════════════════════════════════════════════════════

async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: texto } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
  } catch (e) {
    console.error("[WSP] Error mensaje:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarBotones(to, texto, botones) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
  } catch (e) {
    console.error("[WSP] Error botones:", e.response?.data?.error?.message || e.message);
  }
}

async function enviarImagen(to, imageUrl, caption = "") {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
    );
  } catch (e) {
    console.error("[WSP] Error imagen:", e.response?.data?.error?.message || e.message);
  }
}

async function obtenerUrlMedia(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
  });
  return res.data.url;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUTAS FRECUENTES
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
        "😔 No tenemos móviles disponibles cerca tuyo.\n\nTe avisaremos en cuanto haya uno en los próximos minutos. 🚖"
      );
    }

    if (segundos > 300) {
      delete listaEspera[userPhone];
      if (sessions[userPhone]) sessions[userPhone].step = "inicio";
      continue;
    }

    if (espera.notificado && !espera.recordatorioEnviado) {
      try {
        const chofer = await buscarChoferDisponible(espera.session.origen);
        if (chofer) {
          espera.recordatorioEnviado = true;
          delete listaEspera[userPhone];
          if (sessions[userPhone]) sessions[userPhone].step = "sin_chofer";
          await enviarBotones(userPhone,
            "🚖 ¡Hay un móvil disponible cerca tuyo!\n¿Asignamos uno ahora?",
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
  const chofer = await buscarChoferDisponible(session.origen);

  if (!chofer) {
    listaEspera[userPhone] = {
      session, timestamp: Date.now(),
      notificado: false, recordatorioEnviado: false,
    };
    await enviarMensaje(userPhone, "⏳ Buscando el móvil más cercano para ti...");
    return;
  }

  const viaje = await Viaje.create({
    usuarioPhone: userPhone,
    choferPhone: chofer.phone,
    choferNombre: chofer.nombre,
    choferPlaca: chofer.placa,
    origen: session.origen,
    destino: session.destino,
    distanciaKm: session.distancia,
    precioTotal: session.precio,
    precioPorKm: session.precioPorKm,
    estado: "pendiente",
  });

  session.step = "esperando_chofer";
  session.choferId = chofer.wialonId;
  session.choferPhone = chofer.phone;
  session.viajeId = viaje._id.toString();

  const linkAlOrigen = `https://www.google.com/maps/dir/?api=1&origin=${chofer.ubicacion.lat},${chofer.ubicacion.lng}&destination=${session.origen.lat},${session.origen.lng}&travelmode=driving`;

  await enviarBotones(chofer.phone,
    `🚖 *NUEVO VIAJE*\n\n` +
    `📏 Distancia: ${session.distancia} km\n` +
    `💰 Precio: Bs ${session.precio}\n` +
    `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
    `🗺️ Ir al origen:\n${linkAlOrigen}`,
    [
      { id: "aceptar_viaje", title: "✅ Aceptar" },
      { id: "rechazar_viaje", title: "❌ Rechazar" },
    ]
  );
  await enviarMensaje(userPhone, "🔍 Encontramos un chofer cerca. Esperando confirmación...");
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECCIÓN DE LLEGADA AL DESTINO
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
      if (distDestino < 0.15 && !session.llegadaNotificada) {
        session.llegadaNotificada = true;
        const chofer = await Chofer.findOne({ wialonId: session.choferId });
        if (chofer) {
          await enviarBotones(chofer.phone,
            "📍 Parece que llegaste al destino. ¿Finalizas el viaje?",
            [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
          );
          await enviarMensaje(userPhone, "📍 ¡Tu chofer llegó al destino!");
        }
      }
    } catch { /* ignorar */ }
  }
}, 30000);

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL CHOFER
// ═══════════════════════════════════════════════════════════════════════════

async function procesarMensajeChofer(phone, mensajeTexto, buttonId) {
  let chofer = await Chofer.findOne({ phone });

  // ─── Registro de nuevo chofer ──────────────────────────────────────
  if (!chofer) {
    if (!sessions[phone]) sessions[phone] = { step: "chofer_terminos" };
    const session = sessions[phone];

    if (session.step === "chofer_terminos") {
      await enviarBotones(phone,
        `👋 Bienvenido a *ChatGo*!\n\n` +
        `Antes de registrarte debes aceptar los Términos para Conductores:\n\n` +
        `• Eres contratista independiente\n` +
        `• Debes mantener WiaTag activo con GPS\n` +
        `• Licencia, SOAT e ITV vigentes\n` +
        `• Trato cordial y profesional\n` +
        `• Pago diario de Bs 10\n` +
        `• Prohibido celular mientras conduces`,
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
        session.step = "chofer_registro_wialonid";
        await enviarMensaje(phone, "✅ Términos aceptados.\n\nEnvía tu *ID de Wialon* (solo el número):");
      } else {
        delete sessions[phone];
        await enviarMensaje(phone, "Debes aceptar los términos para usar ChatGo.");
      }
      return;
    }

    if (session.step === "chofer_registro_wialonid") {
      session.wialonId = mensajeTexto.trim();
      session.step = "chofer_registro_placa";
      await enviarMensaje(phone, "Perfecto. Ahora tu *número de placa*:");
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
        phone,
        wialonId: session.wialonId,
        placa: session.placa,
        nombre: mensajeTexto.trim(),
        estado: "offline",
        aceptoTerminos: true,
      });
      delete sessions[phone];
      await enviarBotones(phone,
        `✅ *Registro exitoso!*\n\n` +
        `👤 ${nuevo.nombre}\n🚗 Placa: ${nuevo.placa}\n\n` +
        `Para iniciar tu jornada presiona el botón:`,
        [
          { id: "chofer_libre", title: "🟢 Iniciar jornada" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }
    return;
  }

  // ─── Botones del chofer ────────────────────────────────────────────
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

      await enviarMensaje(userPhone,
        `🎉 *¡Viaje aceptado!*\n\n` +
        `👤 Chofer: ${chofer.nombre}\n🚗 Placa: ${chofer.placa}\n\n` +
        `📍 Rastrea tu chofer:\n${linkRastreo}\n\n` +
        `💬 Escribe cualquier mensaje para chatear con él.`
      );
      await enviarBotones(phone,
        `✅ Viaje aceptado!\n\nCuando llegues al punto de recojo presiona el botón.`,
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
      await enviarMensaje(userPhone,
        `🚕 *¡Tu chofer llegó!*\n\n👤 ${chofer.nombre}\n🚗 ${chofer.placa}\n\nDirígete al vehículo.`
      );
      await enviarBotones(phone,
        `✅ Pasajero notificado.\n\nCuando el pasajero suba presiona:`,
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
      await Viaje.findByIdAndUpdate(session.viajeId, { estado: "en_curso" });
      await enviarMensaje(userPhone, `🚖 *Viaje iniciado*\n\n¡Disfruta tu viaje con ChatGo!`);
      await enviarBotones(phone,
        `▶️ Viaje iniciado. Conduce con cuidado!`,
        [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
      );
      return;
    }

    if (buttonId === "cancelar_viaje_chofer") {
      const entry = Object.entries(sessions).find(([, s]) =>
        (s.step === "chofer_en_camino" || s.step === "chofer_esperando_pasajero") &&
        s.choferId === chofer.wialonId);
      if (entry) {
        const [userPhone, session] = entry;
        await Viaje.findByIdAndUpdate(session.viajeId, { estado: "cancelado_chofer" });
        chofer.estado = "libre";
        await chofer.save();
        await enviarMensaje(userPhone, `❌ Tu chofer canceló el viaje. Puedes pedir otro cuando quieras.`);
        await enviarMensaje(phone, `❌ Viaje cancelado. Ya estás LIBRE.`);
        delete sessions[userPhone];
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      const entry = Object.entries(sessions).find(([, s]) =>
        (s.step === "en_curso" || s.step === "chofer_esperando_pasajero") &&
        s.choferId === chofer.wialonId);
      if (entry) {
        const [userPhone, session] = entry;
        await Viaje.findByIdAndUpdate(session.viajeId, { estado: "completado", fechaFin: new Date() });
        await Usuario.findOneAndUpdate({ phone: userPhone }, { $inc: { viajesTotal: 1 } });
        await Chofer.findOneAndUpdate({ phone }, { estado: "libre", $inc: { viajesTotal: 1 } });
        await guardarRutaFrecuente(userPhone, session.origen, session.destino);
        await enviarMensaje(userPhone,
          `✅ *Viaje completado*\n\n📏 ${session.distancia} km\n💰 Bs ${session.precio}\n\n¡Gracias por usar ChatGo! 🚖`
        );
        await enviarBotones(phone,
          `✅ Viaje finalizado!\n🟢 Ya estás LIBRE para el siguiente viaje.`,
          [
            { id: "chofer_ocupado", title: "🔴 Ocupado" },
            { id: "chofer_ayuda", title: "❓ Ayuda" },
          ]
        );
        delete sessions[userPhone];
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
        await enviarImagen(phone, CONFIG.QR_IMAGE_URL,
          `📲 Escanea el QR y envíame la *foto del comprobante* para activarte.`
        );
        sessions[phone] = { step: "chofer_esperando_comprobante" };
        return;
      }

      chofer.estado = "libre";
      await chofer.save();
      await enviarBotones(phone,
        `✅ Ya estás *LIBRE* y listo para viajes! 🚖`,
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
      await enviarMensaje(phone,
        `❓ *Ayuda ChatGo*\n\n` +
        `🟢 Libre → Recibes viajes\n` +
        `🔴 Ocupado → No recibes viajes\n` +
        `💬 Antes de iniciar el viaje puedes chatear con el pasajero escribiendo cualquier mensaje\n\n` +
        `Para soporte contáctanos al administrador.`
      );
      return;
    }

    if (buttonId.startsWith("aprobar_pago_")) {
      const choferPhone = buttonId.replace("aprobar_pago_", "");
      await Chofer.findOneAndUpdate({ phone: choferPhone }, {
        "pagoDiario.aprobado": true,
        "pagoDiario.fecha": new Date(),
        estado: "libre",
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

  // ─── Comprobante de pago (foto) ────────────────────────────────────
  if (sessions[phone]?.step === "chofer_esperando_comprobante") {
    chofer.pagoDiario = { fecha: new Date(), pagado: true, aprobado: false };
    await chofer.save();
    delete sessions[phone];
    await enviarBotones(CONFIG.ADMIN_PHONE,
      `💰 *Comprobante recibido*\n\n👤 ${chofer.nombre}\n🚗 ${chofer.placa}\n📞 +${phone}`,
      [{ id: `aprobar_pago_${phone}`, title: "✅ Aprobar" }]
    );
    await enviarMensaje(phone, "⏳ Comprobante recibido. Esperando aprobación del administrador...");
    return;
  }

  // ─── Chat con pasajero durante espera ──────────────────────────────
  const viajeEspera = Object.entries(sessions).find(([, s]) =>
    (s.step === "chofer_en_camino" || s.step === "chofer_esperando_pasajero") &&
    s.choferId === chofer.wialonId);
  if (viajeEspera && mensajeTexto && mensajeTexto.trim()) {
    const [userPhone] = viajeEspera;
    await enviarMensaje(userPhone, `💬 *Mensaje de tu chofer:*\n${mensajeTexto.trim()}`);
    await enviarMensaje(phone, "✅ Enviado al pasajero");
    return;
  }

  // ─── Cualquier otro mensaje → menú con botones ─────────────────────
  const hoy = new Date();
  const yaPageHoy = chofer.pagoDiario?.aprobado &&
    chofer.pagoDiario?.fecha &&
    new Date(chofer.pagoDiario.fecha).toDateString() === hoy.toDateString();
  
  console.log(`[PAGO_CHECK] Chofer: ${phone}`);
  console.log(`[PAGO_CHECK] pagoDiario:`, JSON.stringify(chofer.pagoDiario));
  console.log(`[PAGO_CHECK] aprobado: ${chofer.pagoDiario?.aprobado}`);
  console.log(`[PAGO_CHECK] fecha: ${chofer.pagoDiario?.fecha}`);
  console.log(`[PAGO_CHECK] hoy: ${hoy.toDateString()}, pagoDate: ${chofer.pagoDiario?.fecha ? new Date(chofer.pagoDiario.fecha).toDateString() : 'N/A'}`);
  console.log(`[PAGO_CHECK] yaPageHoy: ${yaPageHoy}`);

  if (!yaPageHoy) {
    chofer.estado = "offline";
    await chofer.save();
    await enviarMensaje(phone, `👋 Hola ${chofer.nombre}!\n\nPara iniciar tu jornada necesitas pagar *Bs 10*.`);
    await enviarImagen(phone, CONFIG.QR_IMAGE_URL,
      `📲 Escanea el QR y envíame la *foto del comprobante*.`);
    sessions[phone] = { step: "chofer_esperando_comprobante" };
    return;
  }

  if (chofer.estado === "libre") {
    await enviarBotones(phone,
      `👋 Hola ${chofer.nombre}!\n\n🟢 Estás *LIBRE* y recibiendo viajes.`,
      [
        { id: "chofer_ocupado", title: "🔴 Ocupado" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  } else {
    await enviarBotones(phone,
      `👋 Hola ${chofer.nombre}!\n\n${chofer.estado === "ocupado" ? "🔴 Estás *OCUPADO*" : "⚪ Estás desconectado"}`,
      [
        { id: "chofer_libre", title: "🟢 Libre" },
        { id: "chofer_ayuda", title: "❓ Ayuda" },
      ]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAR MENSAJE DEL USUARIO
// ═══════════════════════════════════════════════════════════════════════════

async function procesarCalculoViaje(phone, session) {
  session.step = "calculando";
  await enviarMensaje(phone, "⏳ Calculando ruta y precio...");

  try {
    const { km, duracion } = await calcularDistancia(session.origen, session.destino);
    const { total, precioPorKm } = calcularPrecio(km);
    session.distancia = km;
    session.precio = total;
    session.precioPorKm = precioPorKm;
    session.step = "esperando_confirmacion";

    await enviarBotones(phone,
      `🗺️ *Resumen del viaje*\n\n` +
      `📍 Origen: ${session.origen.nombre || "Tu ubicación"}\n` +
      `🏁 Destino: ${session.destino.nombre || "Tu destino"}\n\n` +
      `📏 Distancia: ${km} km\n` +
      `⏱️ Tiempo: ${duracion}\n` +
      `💰 *Precio: Bs ${total}*\n\n` +
      `¿Confirmas el viaje?`,
      [
        { id: "confirmar_viaje", title: "✅ Confirmar" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]
    );
  } catch (e) {
    console.error("[CALCULO]", e.message);
    await enviarMensaje(phone, "❌ Error calculando. Intenta de nuevo.");
    session.step = "esperando_origen";
  }
}

async function procesarMensajeUsuario(phone, mensaje, buttonId) {
  let usuario = await Usuario.findOne({ phone });

  // ─── Términos y condiciones ────────────────────────────────────────
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
        `👋 Bienvenido a *ChatGo* de Lukmi S.R.L.\n\n` +
        `Términos y Condiciones:\n\n` +
        `• ChatGo es intermediación tecnológica\n` +
        `• Tu ubicación GPS se usa solo para el viaje\n` +
        `• No compartimos tu info con terceros\n` +
        `• Pago directo al conductor\n` +
        `• Jurisdicción: Cochabamba, Bolivia\n\n` +
        `¿Aceptas?`,
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
        usuario = await Usuario.create({ phone, aceptoTerminos: true });
        delete sessions[phone];
        await enviarMensaje(phone, "✅ ¡Bienvenido a ChatGo!\n\nEscribe cualquier mensaje o envía un audio para pedir tu taxi. 🚖");
      } else {
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos.");
        delete sessions[phone];
      }
      return;
    }
  }

  if (!sessions[phone]) sessions[phone] = { step: "inicio" };
  const session = sessions[phone];

  // ─── Extraer coordenadas ───────────────────────────────────────────
  let coords = null;
  if (mensaje.location) {
    const lat = parseFloat(mensaje.location.latitude ?? mensaje.location.lat);
    const lng = parseFloat(mensaje.location.longitude ?? mensaje.location.lng ?? mensaje.location.lon);
    if (!isNaN(lat) && !isNaN(lng)) {
      coords = { lat, lng };
      console.log(`[UBICACION] ${phone}: lat=${lat}, lng=${lng}`);
    }
  }

  const texto = mensaje.text?.body?.trim() || "";

  // ─── Chat automático con chofer durante espera ─────────────────────
  if (texto && !buttonId &&
      (session.step === "esperando_chofer" ||
       session.step === "chofer_en_camino" ||
       session.step === "chofer_esperando_pasajero")) {
    if (session.choferPhone) {
      await enviarMensaje(session.choferPhone, `💬 *Mensaje del pasajero:*\n${texto}`);
      await enviarMensaje(phone, "✅ Enviado al chofer");
    }
    return;
  }

  // ─── Audio de voz ──────────────────────────────────────────────────
  if (mensaje.type === "audio" || mensaje.type === "voice") {
    await enviarMensaje(phone, "🎤 Procesando tu mensaje de voz...");
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      await enviarMensaje(phone, `🎤 Escuché: _"${transcripcion}"_`);

      const ubicaciones = await extraerUbicaciones(transcripcion);

      if (ubicaciones.origen && !ubicaciones.destino) {
        const origenCoords = await geocodificarDireccion(ubicaciones.origen);
        if (origenCoords) {
          origenCoords.nombre = ubicaciones.origen;
          session.origen = origenCoords;
        }
        session.step = "esperando_destino";
        await enviarMensaje(phone, `✅ Origen: *${ubicaciones.origen}*\n\n🏁 Ahora dime tu *destino*.`);
        return;
      }

      if (!ubicaciones.origen && ubicaciones.destino) {
        const destinoCoords = await geocodificarDireccion(ubicaciones.destino);
        if (destinoCoords) {
          destinoCoords.nombre = ubicaciones.destino;
          session.destino = destinoCoords;
        }
        session.step = "esperando_origen";
        await enviarMensaje(phone, `✅ Destino: *${ubicaciones.destino}*\n\n📍 Ahora dime tu *origen*.`);
        return;
      }

      if (!ubicaciones.origen && !ubicaciones.destino) {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "No pude identificar ubicaciones.\n📍 Envía tu origen con el pin de WhatsApp.");
        return;
      }

      const origenCoords = await geocodificarDireccion(ubicaciones.origen);
      const destinoCoords = await geocodificarDireccion(ubicaciones.destino);

      if (!origenCoords || !destinoCoords) {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "No encontré las ubicaciones.\n📍 Envía tu origen con el pin.");
        return;
      }

      origenCoords.nombre = ubicaciones.origen;
      destinoCoords.nombre = ubicaciones.destino;
      session.origenPendiente = origenCoords;
      session.destinoPendiente = destinoCoords;
      session.step = "confirmando_ubicaciones_voz";

      await enviarBotones(phone,
        `📍 *¿Confirmas estas ubicaciones?*\n\n` +
        `🚀 Origen: ${ubicaciones.origen}\n` +
        `🏁 Destino: ${ubicaciones.destino}`,
        [
          { id: "confirmar_ubicaciones", title: "✅ Sí" },
          { id: "corregir_origen", title: "📍 Cambiar origen" },
          { id: "corregir_destino", title: "📍 Cambiar destino" },
        ]
      );
    } catch (e) {
      console.error("[AUDIO]", e.message);
      await enviarMensaje(phone, "❌ Error procesando audio. Envía el pin de ubicación.");
      session.step = "esperando_origen";
    }
    return;
  }

  // ─── Switch de steps ───────────────────────────────────────────────
  switch (session.step) {
    case "inicio": {
      const rutaFrecuente = await verificarRutaFrecuente(phone);
      if (rutaFrecuente) {
        session.rutaFrecuente = rutaFrecuente;
        session.step = "preguntando_ruta_frecuente";
        await enviarBotones(phone,
          `👋 ¡Hola!\n\n¿Vas al mismo lugar de siempre?\n\n` +
          `📍 ${rutaFrecuente.origen.nombre || "Origen habitual"}\n` +
          `🏁 ${rutaFrecuente.destino.nombre || "Destino habitual"}`,
          [
            { id: "usar_ruta_frecuente", title: "✅ Sí" },
            { id: "nueva_ruta", title: "📍 Nueva ruta" },
          ]
        );
      } else {
        session.step = "esperando_origen";
        await enviarMensaje(phone,
          "👋 ¡Hola! Bienvenido a *ChatGo*.\n\n" +
          "📍 Envía tu ubicación de origen usando el pin de WhatsApp.\n\n" +
          "También puedes enviar un 🎤 mensaje de voz diciendo a dónde quieres ir."
        );
      }
      break;
    }

    case "preguntando_ruta_frecuente":
      if (buttonId === "usar_ruta_frecuente") {
        session.origen = session.rutaFrecuente.origen;
        session.destino = session.rutaFrecuente.destino;
        await procesarCalculoViaje(phone, session);
      } else {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "📍 Envía tu *ubicación de origen* con el pin de WhatsApp.");
      }
      break;

    case "esperando_origen":
      if (!coords) {
        await enviarMensaje(phone,
          "📍 Estoy esperando tu ubicación de origen.\n" +
          "Usa el 📎 adjunto → Ubicación, o envía un 🎤 audio."
        );
        break;
      }
      session.origen = coords;
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) session.origen.nombre = dir;
      } catch {}
      session.step = "esperando_destino";
      await enviarMensaje(phone, "✅ Origen recibido.\n\n🏁 Ahora envía tu *ubicación de destino*.");
      break;

    case "esperando_destino":
      if (!coords) {
        await enviarMensaje(phone, "🏁 Estoy esperando tu ubicación de destino.\nUsa el 📎 adjunto → Ubicación.");
        break;
      }
      session.destino = coords;
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) session.destino.nombre = dir;
      } catch {}
      await procesarCalculoViaje(phone, session);
      break;

    case "confirmando_ubicaciones_voz":
      if (buttonId === "confirmar_ubicaciones") {
        session.origen = session.origenPendiente;
        session.destino = session.destinoPendiente;
        delete session.origenPendiente;
        delete session.destinoPendiente;
        await procesarCalculoViaje(phone, session);
      } else if (buttonId === "corregir_origen") {
        session.destino = session.destinoPendiente;
        delete session.origenPendiente;
        delete session.destinoPendiente;
        session.step = "esperando_origen";
        await enviarMensaje(phone, "📍 Envía tu *ubicación de origen* con el pin.");
      } else if (buttonId === "corregir_destino") {
        session.origen = session.origenPendiente;
        delete session.origenPendiente;
        delete session.destinoPendiente;
        session.step = "esperando_destino";
        await enviarMensaje(phone, "🏁 Envía tu *ubicación de destino* con el pin.");
      }
      break;

    case "esperando_confirmacion": {
      const textoConf = texto.toUpperCase();
      if (buttonId === "confirmar_viaje" || textoConf === "SI" || textoConf === "SÍ" || textoConf === "CONFIRMAR") {
        session.step = "confirmado";
        await enviarMensaje(phone, "✅ Viaje confirmado. Buscando chofer...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje" || textoConf === "NO" || textoConf === "CANCELAR") {
        delete sessions[phone];
        await enviarMensaje(phone, "❌ Viaje cancelado.");
      } else {
        await enviarBotones(phone,
          `Por favor confirma o cancela:\n\n` +
          `📏 ${session.distancia} km\n💰 Bs ${session.precio}`,
          [
            { id: "confirmar_viaje", title: "✅ Confirmar" },
            { id: "cancelar_viaje", title: "❌ Cancelar" },
          ]
        );
      }
      break;
    }

    case "sin_chofer":
      if (buttonId === "confirmar_viaje_recordatorio") {
        await enviarMensaje(phone, "✅ Perfecto! Buscando tu chofer...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje") {
        delete sessions[phone];
        delete listaEspera[phone];
        await enviarMensaje(phone, "❌ Entendido. Escribe cuando necesites taxi. 🚖");
      } else {
        await enviarMensaje(phone, "⏳ Seguimos buscando un móvil para ti...");
      }
      break;

    case "esperando_chofer":
      if (!buttonId) {
        await enviarMensaje(phone, "⏳ Ya estamos buscando tu chofer...");
      }
      break;

    case "en_curso":
      await enviarMensaje(phone, "🚖 Tu viaje está en curso. ¡Disfrútalo!");
      break;

    default:
      delete sessions[phone];
      sessions[phone] = { step: "inicio" };
      await procesarMensajeUsuario(phone, mensaje, buttonId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK META
// ═══════════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === CONFIG.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
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
      if (msg.location) console.log(`[WEBHOOK] LOCATION:`, JSON.stringify(msg.location));

      const esChofer = await Chofer.exists({ phone });
      const esRegistroChofer =
        textoUpper === "CHOFER" || textoUpper === "SOY CHOFER" || textoUpper === "CONDUCTOR" ||
        (sessions[phone] && sessions[phone].step?.startsWith("chofer_"));
      
      console.log(`[ROUTING] Phone: ${phone}, esChofer: ${!!esChofer}, esRegistroChofer: ${esRegistroChofer}, session: ${sessions[phone]?.step || 'none'}`);

      // Si es el admin aprobando un pago, procesar aquí directamente
      if (buttonId && buttonId.startsWith("aprobar_pago_")) {
        const choferPhone = buttonId.replace("aprobar_pago_", "");
        await Chofer.findOneAndUpdate({ phone: choferPhone }, {
          "pagoDiario.aprobado": true,
          "pagoDiario.fecha": new Date(),
          estado: "libre",
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
  } catch (e) {
    console.error("[WEBHOOK] Error:", e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINT: LISTAR UNIDADES DE WIALON
// ═══════════════════════════════════════════════════════════════════════════

app.get("/unidades", async (req, res) => {
  try {
    const eid = await wialonLogin();
    const resp = await axios.get("https://hst-api.wialon.com/wialon/ajax.html", {
      params: {
        svc: "core/search_items",
        params: JSON.stringify({
          spec: {
            itemsType: "avl_unit",
            propName: "sys_name",
            propValueMask: "*",
            sortType: "sys_name",
          },
          force: 1,
          flags: 4294967295,
          from: 0,
          to: 0,
        }),
        sid: eid,
      },
    });
    
    if (!resp.data.items) {
      return res.json({ error: "No se encontraron unidades", raw: resp.data });
    }
    
    const unidades = resp.data.items.map(u => ({
      id: u.id,
      nombre: u.nm,
      uid: u.uid || u.uid2 || "",
      ultimaPos: u.pos ? {
        lat: u.pos.y,
        lng: u.pos.x,
        hace_min: Math.round((Date.now()/1000 - (u.pos.t || 0)) / 60),
      } : null,
    }));
    
    res.json({ total: unidades.length, unidades });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 ChatGo corriendo en puerto ${PORT}`));
