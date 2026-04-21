const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const FormData = require("form-data");
const app = express();
app.use(express.json());

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const CONFIG = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY,
  WIALON_TOKEN: process.env.WIALON_TOKEN,
  OPENAI_KEY: process.env.OPENAI_KEY,
  MONGODB_URI: process.env.MONGODB_URI,
  ADMIN_PHONE: process.env.ADMIN_PHONE, // número del administrador
  QR_IMAGE_URL: process.env.QR_IMAGE_URL, // URL de imagen QR BCP
};

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(CONFIG.MONGODB_URI);

// Schema Usuario
const usuarioSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  nombre: String,
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
  viajesTotal: { type: Number, default: 0 },
  rutasFrecuentes: [
    {
      origen: { lat: Number, lng: Number, nombre: String },
      destino: { lat: Number, lng: Number, nombre: String },
      contador: { type: Number, default: 1 },
    },
  ],
});

// Schema Chofer
const choferSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  wialonId: String,
  placa: String,
  nombre: String,
  estado: { type: String, default: "offline" }, // offline, libre, ocupado
  pagoDiario: {
    fecha: Date,
    pagado: { type: Boolean, default: false },
    comprobante: String,
    aprobado: { type: Boolean, default: false },
  },
  viajesTotal: { type: Number, default: 0 },
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
});

// Schema Viaje
const viajeSchema = new mongoose.Schema({
  usuarioPhone: String,
  choferPhone: String,
  choferNombre: String,
  choferPlaca: String,
  origen: { lat: Number, lng: Number },
  destino: { lat: Number, lng: Number },
  distanciaKm: Number,
  precioTotal: Number,
  precioPorKm: Number,
  estado: { type: String, default: "pendiente" }, // pendiente, en_curso, completado, cancelado
  fechaInicio: { type: Date, default: Date.now },
  fechaFin: Date,
});

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);

// ─── ESTADO EN MEMORIA (sesiones activas) ────────────────────────────────────
const sessions = {};
// { phone: { step, origen, destino, precio, distancia, choferId, viajeId } }

// ─── TARIFAS ─────────────────────────────────────────────────────────────────
function calcularPrecio(km) {
  let precioPorKm;
  if (km < 4) precioPorKm = 4.0;
  else if (km < 10) precioPorKm = 3.5;
  else precioPorKm = 2.5;
  const calculado = km * precioPorKm;
  const total = Math.round(Math.max(calculado, 6));
  return { total, precioPorKm };
}

// ─── GOOGLE MAPS DISTANCIA ────────────────────────────────────────────────────
async function calcularDistancia(origen, destino) {
  const res = await axios.get(
    "https://maps.googleapis.com/maps/api/distancematrix/json",
    {
      params: {
        origins: `${origen.lat},${origen.lng}`,
        destinations: `${destino.lat},${destino.lng}`,
        key: CONFIG.GOOGLE_MAPS_KEY,
        mode: "driving",
      },
    }
  );

  // Verificar errores de la API
  if (res.data.status !== "OK") {
    console.error("Google Maps API error:", res.data.status, res.data.error_message);
    // Fallback: calcular distancia con Haversine si Google Maps falla
    const km = distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng);
    const kmRedondeado = Math.round(km * 10) / 10;
    return { km: kmRedondeado, duracion: "~" + Math.round(km * 3) + " min" };
  }

  const row = res.data.rows?.[0];
  const element = row?.elements?.[0];

  if (!element || element.status !== "OK") {
    console.error("Google Maps element error:", element?.status);
    // Fallback con Haversine
    const km = distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng);
    const kmRedondeado = Math.round(km * 10) / 10;
    return { km: kmRedondeado, duracion: "~" + Math.round(km * 3) + " min" };
  }

  return {
    km: Math.round((element.distance.value / 1000) * 10) / 10,
    duracion: element.duration.text,
  };
}

// ─── GOOGLE MAPS GEOCODING ────────────────────────────────────────────────────
async function geocodificarDireccion(direccion) {
  const res = await axios.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        address: `${direccion}, Cochabamba, Bolivia`,
        key: CONFIG.GOOGLE_MAPS_KEY,
      },
    }
  );
  if (res.data.results.length === 0) return null;
  const loc = res.data.results[0].geometry.location;
  const nombre = res.data.results[0].formatted_address;
  return { lat: loc.lat, lng: loc.lng, nombre };
}

// ─── GOOGLE MAPS GEOCODING INVERSO (coordenadas → dirección) ──────────────────
async function obtenerDireccion(lat, lng) {
  try {
    const res = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          latlng: `${lat},${lng}`,
          key: CONFIG.GOOGLE_MAPS_KEY,
          language: "es",
        },
      }
    );
    if (res.data.results.length === 0) return null;
    // Tomar dirección corta (calle + número)
    const resultado = res.data.results[0];
    const componentes = resultado.address_components;
    const calle = componentes.find(c => c.types.includes("route"))?.long_name || "";
    const numero = componentes.find(c => c.types.includes("street_number"))?.long_name || "";
    const barrio = componentes.find(c => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name || "";
    if (calle) return numero ? `${calle} ${numero}` : (barrio ? `${calle}, ${barrio}` : calle);
    return resultado.formatted_address.split(",")[0];
  } catch(e) {
    return null;
  }
}

// ─── WIALON ───────────────────────────────────────────────────────────────────
async function wialonLogin() {
  const res = await axios.get(
    "https://hst-api.wialon.com/wialon/ajax.html",
    {
      params: {
        svc: "token/login",
        params: JSON.stringify({ token: CONFIG.WIALON_TOKEN }),
      },
    }
  );
  return res.data.eid;
}

async function obtenerUbicacionChofer(wialonId) {
  const eid = await wialonLogin();
  const res = await axios.get(
    "https://hst-api.wialon.com/wialon/ajax.html",
    {
      params: {
        svc: "core/search_item",
        params: JSON.stringify({ id: parseInt(wialonId), flags: 1025 }),
        sid: eid,
      },
    }
  );
  const pos = res.data.item.pos;
  return { lat: pos.y, lng: pos.x };
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function distanciaEntrePuntos(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── WHISPER — TRANSCRIPCIÓN DE AUDIO ────────────────────────────────────────
async function transcribirAudio(audioUrl) {
  // Descargar audio de WhatsApp
  const audioRes = await axios.get(audioUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` },
  });

  const formData = new FormData();
  formData.append("file", Buffer.from(audioRes.data), {
    filename: "audio.ogg",
    contentType: "audio/ogg",
  });
  formData.append("model", "whisper-1");
  formData.append("language", "es");

  const res = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENAI_KEY}`,
        ...formData.getHeaders(),
      },
    }
  );
  return res.data.text;
}

// ─── GPT — EXTRAER ORIGEN Y DESTINO DEL TEXTO ────────────────────────────────
async function extraerUbicaciones(texto) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un asistente que extrae origen y destino de mensajes de taxi en Cochabamba, Bolivia.
Responde SOLO en JSON con este formato exacto:
{"origen": "nombre del lugar", "destino": "nombre del lugar"}
Si no puedes identificar claramente alguno, usa null.

Reglas importantes:
- En Cbba la gente da referencias como: "Av. Blanco Galindo esquina C. 5", "frente al mercado Calatayud", "SIDUMSS Norte Av. Tercera", "Estadium esquina noreste"
- Extrae la referencia completa incluyendo avenida, calle, barrio y referencia adicional
- Si solo mencionan origen sin destino, origen tiene valor y destino es null
- Si solo mencionan destino sin origen, destino tiene valor y origen es null
- Ejemplos de lugares conocidos en Cbba: Plaza 14 de Septiembre, Terminal de Buses, Aeropuerto Jorge Wilstermann, UMSS, Mall Las Americas, Hipermaxi, Estadium Felix Capriles, Cristo de la Concordia`,
        },
        { role: "user", content: texto },
      ],
      max_tokens: 150,
    },
    { headers: { Authorization: `Bearer ${CONFIG.OPENAI_KEY}` } }
  );

  try {
    const content = res.data.choices[0].message.content;
    return JSON.parse(content.replace(/```json|```/g, "").trim());
  } catch {
    return { origen: null, destino: null };
  }
}

// ─── BUSCAR CHOFER DISPONIBLE ─────────────────────────────────────────────────
async function buscarChoferDisponible(origenUsuario) {
  const choferes = await Chofer.find({ estado: "libre" });
  if (choferes.length === 0) return null;

  let mejorChofer = null;
  let menorDistancia = Infinity;

  for (const chofer of choferes) {
    try {
      const pos = await obtenerUbicacionChofer(chofer.wialonId);
      const dist = distanciaEntrePuntos(
        origenUsuario.lat,
        origenUsuario.lng,
        pos.lat,
        pos.lng
      );
      if (dist < menorDistancia) {
        menorDistancia = dist;
        mejorChofer = {
          ...chofer.toObject(),
          ubicacion: pos,
          distanciaAlUsuario: dist,
        };
      }
    } catch (e) {
      console.error(`Error ubicación chofer ${chofer.wialonId}:`, e.message);
    }
  }
  return mejorChofer;
}

// ─── WHATSAPP — ENVIAR TEXTO ──────────────────────────────────────────────────
async function enviarMensaje(to, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: texto },
    },
    { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
  );
}

// ─── WHATSAPP — ENVIAR BOTONES ────────────────────────────────────────────────
async function enviarBotones(to, texto, botones) {
  // botones = [{ id: "btn_id", title: "Texto botón" }] max 3
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
          buttons: botones.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
  );
}

// ─── WHATSAPP — ENVIAR IMAGEN ─────────────────────────────────────────────────
async function enviarImagen(to, imageUrl, caption = "") {
  await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    },
    { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
  );
}

// ─── WHATSAPP — OBTENER URL DE MEDIA ─────────────────────────────────────────
async function obtenerUrlMedia(mediaId) {
  const res = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}` } }
  );
  return res.data.url;
}

// ─── RUTAS FRECUENTES ────────────────────────────────────────────────────────
async function verificarRutaFrecuente(phone) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario || usuario.rutasFrecuentes.length === 0) return null;
  const rutas = usuario.rutasFrecuentes.sort((a, b) => b.contador - a.contador);
  const top = rutas[0];
  if (top.contador >= 3) return top; // mostrar si viajó 3+ veces esta ruta
  return null;
}

async function guardarRutaFrecuente(phone, origen, destino) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario) return;

  const existente = usuario.rutasFrecuentes.find(
    (r) =>
      Math.abs(r.origen.lat - origen.lat) < 0.001 &&
      Math.abs(r.destino.lat - destino.lat) < 0.001
  );

  if (existente) {
    existente.contador += 1;
  } else {
    usuario.rutasFrecuentes.push({ origen, destino, contador: 1 });
  }
  await usuario.save();
}

// ─── ASIGNAR CHOFER ───────────────────────────────────────────────────────────
async function asignarChofer(userPhone, session) {
  const chofer = await buscarChoferDisponible(session.origen);

  if (!chofer) {
    await enviarMensaje(
      userPhone,
      "😔 No hay choferes disponibles en este momento.\nPor favor intenta en unos minutos."
    );
    session.step = "inicio";
    return;
  }

  // Crear viaje en BD
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

  const linkMaps = `https://www.google.com/maps/dir/?api=1&origin=${chofer.ubicacion.lat},${chofer.ubicacion.lng}&destination=${session.origen.lat},${session.origen.lng}&travelmode=driving`;

  await enviarBotones(
    chofer.phone,
    `🚖 *NUEVO VIAJE*\n\n` +
      `📏 Distancia: ${session.distancia} km\n` +
      `💰 Precio: Bs ${session.precio}\n` +
      `📌 Estás a ${Math.round(chofer.distanciaAlUsuario * 10) / 10} km del pasajero\n\n` +
      `🗺️ Ir al origen:\n${linkMaps}`,
    [
      { id: "aceptar_viaje", title: "✅ Aceptar" },
      { id: "rechazar_viaje", title: "❌ Rechazar" },
    ]
  );

  await enviarMensaje(
    userPhone,
    "🔍 Encontramos un chofer cerca. Esperando confirmación..."
  );
}

// ─── DETECCIÓN DE LLEGADA (se llama periódicamente) ───────────────────────────
async function verificarLlegadas() {
  const viajesEnCurso = Object.entries(sessions).filter(
    ([, s]) => s.step === "en_curso"
  );

  for (const [userPhone, session] of viajesEnCurso) {
    try {
      const chofer = await Chofer.findOne({ wialonId: session.choferId });
      if (!chofer) continue;

      const posChofer = await obtenerUbicacionChofer(session.choferId);
      const distAlDestino = distanciaEntrePuntos(
        posChofer.lat,
        posChofer.lng,
        session.destino.lat,
        session.destino.lng
      );

      // Si está a menos de 150 metros del destino
      if (distAlDestino < 0.15 && !session.llegadaNotificada) {
        session.llegadaNotificada = true;

        await enviarBotones(
          chofer.phone,
          "📍 Parece que llegaste al destino. ¿Deseas finalizar el viaje?",
          [{ id: "terminar_viaje", title: "🏁 Terminar viaje" }]
        );

        await enviarMensaje(
          userPhone,
          "📍 ¡Tu chofer ha llegado a tu destino!\nEsperando confirmación del chofer para cerrar el viaje."
        );
      }
    } catch (e) {
      console.error("Error verificando llegada:", e.message);
    }
  }
}

// Verificar llegadas cada 30 segundos
setInterval(verificarLlegadas, 30000);

// ─── PROCESAR MENSAJE CHOFER ──────────────────────────────────────────────────
async function procesarMensajeChofer(phone, mensaje, buttonId) {
  let chofer = await Chofer.findOne({ phone });

  // — Registro nuevo chofer —
  if (!chofer) {
    if (!sessions[phone]) sessions[phone] = { step: "chofer_terminos" };
    const session = sessions[phone];

    if (session.step === "chofer_terminos") {
      await enviarBotones(
        phone,
        `👋 Bienvenido a *ChatGo* de Lukmi S.R.L.\n\nAntes de registrarte debes aceptar los Términos y Condiciones para Conductores:\n\n` +
          `• Eres contratista independiente, no empleado de Lukmi S.R.L.\n` +
          `• Debes mantener WiaTag activo con GPS y datos durante tu turno.\n` +
          `• Debes portar Licencia, SOAT e ITV vigentes.\n` +
          `• Trato cordial y profesional con pasajeros en todo momento.\n` +
          `• Pago diario de Bs 10 por uso de plataforma.\n` +
          `• Prohibido usar el celular mientras el vehículo está en movimiento.\n\n` +
          `¿Aceptas los términos y condiciones?`,
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
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos. Escribe cualquier mensaje para intentar de nuevo.");
      }
      return;
    }

    if (session.step === "chofer_registro_wialonid") {
      session.wialonId = mensaje.trim();
      session.step = "chofer_registro_placa";
      await enviarMensaje(phone, "Perfecto. Ahora envía tu *número de placa*:");
      return;
    }

    if (session.step === "chofer_registro_placa") {
      session.placa = mensaje.trim().toUpperCase();
      session.step = "chofer_registro_nombre";
      await enviarMensaje(phone, "Envía tu *nombre completo*:");
      return;
    }

    if (session.step === "chofer_registro_nombre") {
      const nuevoChofer = await Chofer.create({
        phone,
        wialonId: session.wialonId,
        placa: session.placa,
        nombre: mensaje.trim(),
        estado: "offline",
        aceptoTerminos: true,
      });
      delete sessions[phone];
      await enviarMensaje(
        phone,
        `✅ *Registro exitoso en ChatGo*\n\n` +
          `👤 Nombre: ${nuevoChofer.nombre}\n` +
          `🚗 Placa: ${nuevoChofer.placa}\n` +
          `📍 ID Wialon: ${nuevoChofer.wialonId}\n\n` +
          `Para iniciar tu jornada envía *LIBRE*.\n` +
          `Comandos disponibles:\n` +
          `• *LIBRE* → Disponible para viajes\n` +
          `• *OCUPADO* → No disponible\n` +
          `• *MSG* → Enviar mensaje al pasajero`
      );
      return;
    }
    return;
  }

  // — Botones —
  if (buttonId) {
    if (buttonId === "aceptar_viaje") {
      const viaje = Object.entries(sessions).find(
        ([, s]) => s.step === "esperando_chofer" && s.choferId === chofer.wialonId
      );
      if (!viaje) {
        await enviarMensaje(phone, "No tienes viajes pendientes.");
        return;
      }
      const [userPhone, session] = viaje;
      chofer.estado = "ocupado";
      await chofer.save();

      await Viaje.findByIdAndUpdate(session.viajeId, { estado: "en_curso" });
      session.step = "en_curso";

      const linkWialon = `https://hosting.wialon.com/?token=${CONFIG.WIALON_TOKEN}&id=${chofer.wialonId}`;

      await enviarMensaje(
        userPhone,
        `🎉 *¡Tu viaje fue aceptado!*\n\n` +
          `👤 Chofer: ${chofer.nombre}\n` +
          `🚗 Placa: ${chofer.placa}\n\n` +
          `📍 Rastrea tu chofer en tiempo real:\n${linkWialon}\n\n` +
          `💬 Para enviar un mensaje a tu chofer escribe:\n*MSG tu mensaje aquí*`
      );
      await enviarMensaje(phone, `✅ Viaje aceptado. ¡Buen viaje!\n💬 Para enviar mensaje al pasajero escribe:\n*MSG tu mensaje aquí*`);
      return;
    }

    if (buttonId === "rechazar_viaje") {
      const viaje = Object.entries(sessions).find(
        ([, s]) => s.step === "esperando_chofer" && s.choferId === chofer.wialonId
      );
      if (viaje) {
        const [userPhone, session] = viaje;
        session.choferId = null;
        session.step = "confirmado";
        await enviarMensaje(userPhone, "⏳ El chofer no pudo aceptar. Buscando otro...");
        await asignarChofer(userPhone, session);
      }
      return;
    }

    if (buttonId === "terminar_viaje") {
      const viaje = Object.entries(sessions).find(
        ([, s]) => s.step === "en_curso" && s.choferId === chofer.wialonId
      );
      if (viaje) {
        const [userPhone, session] = viaje;

        await Viaje.findByIdAndUpdate(session.viajeId, {
          estado: "completado",
          fechaFin: new Date(),
        });

        await Usuario.findOneAndUpdate(
          { phone: userPhone },
          { $inc: { viajesTotal: 1 } }
        );
        await Chofer.findOneAndUpdate(
          { phone },
          { estado: "libre", $inc: { viajesTotal: 1 } }
        );

        await guardarRutaFrecuente(userPhone, session.origen, session.destino);

        await enviarMensaje(userPhone, `✅ *Viaje completado*\n\n📏 ${session.distancia} km\n💰 Bs ${session.precio}\n\n¡Gracias por usar ChatGo! 🚖`);
        await enviarMensaje(phone, "✅ Viaje finalizado. Estado cambiado a *LIBRE*.\n¡Listo para el siguiente viaje!");

        delete sessions[userPhone];
      }
      return;
    }

    // Botones de estado del chofer
    if (buttonId === "chofer_libre") {
      // Verificar pago diario antes de ponerlo libre
      const hoy = new Date();
      const pagoDiario = chofer.pagoDiario;
      const yaPageHoy =
        pagoDiario?.aprobado &&
        pagoDiario?.fecha &&
        new Date(pagoDiario.fecha).toDateString() === hoy.toDateString();

      if (!yaPageHoy) {
        chofer.estado = "offline";
        await chofer.save();
        await enviarMensaje(phone, `Para estar LIBRE primero necesitas pagar tu cuota diaria de *Bs 10*.`);
        await enviarImagen(
          phone,
          CONFIG.QR_IMAGE_URL,
          `📲 Escanea el QR, paga y envíame la *foto del comprobante* para activarte. 🚖`
        );
        sessions[phone] = { step: "chofer_esperando_comprobante" };
        return;
      }

      chofer.estado = "libre";
      await chofer.save();
      await enviarBotones(
        phone,
        `✅ Ya estás *LIBRE* y listo para recibir viajes! 🚖`,
        [
          { id: "chofer_ocupado", title: "🔴 Ponerme Ocupado" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }

    if (buttonId === "chofer_ocupado") {
      chofer.estado = "ocupado";
      await chofer.save();
      await enviarBotones(
        phone,
        `🔴 Estado actualizado a *OCUPADO*.`,
        [
          { id: "chofer_libre", title: "🟢 Ponerme Libre" },
          { id: "chofer_ayuda", title: "❓ Ayuda" },
        ]
      );
      return;
    }

    if (buttonId === "chofer_ayuda") {
      await enviarMensaje(
        phone,
        `❓ *Ayuda ChatGo*

` +
        `🟢 Libre → Recibes viajes
` +
        `🔴 Ocupado → No recibes viajes
` +
        `💬 MSG <texto> → Enviar mensaje al pasajero durante un viaje

` +
        `Para soporte escribe al administrador.`
      );
      return;
    }

    // Pago aprobado por admin
    if (buttonId && buttonId.startsWith("aprobar_pago_")) {
      const choferPhone = buttonId.replace("aprobar_pago_", "");
      await Chofer.findOneAndUpdate(
        { phone: choferPhone },
        {
          "pagoDiario.aprobado": true,
          "pagoDiario.fecha": new Date(),
          estado: "libre",
        }
      );
      await enviarMensaje(choferPhone, "✅ *Pago confirmado*\n¡Ya estás en línea! Puedes recibir viajes. 🚖");
      await enviarMensaje(phone, `✅ Pago aprobado para ${choferPhone}`);
      return;
    }
  }

  // — Comandos de texto —
  const texto = mensaje.trim().toUpperCase();

  if (texto === "LIBRE") {
    // Verificar pago diario
    const hoy = new Date();
    const pagoDiario = chofer.pagoDiario;
    const yaPageHoy =
      pagoDiario?.aprobado &&
      pagoDiario?.fecha &&
      new Date(pagoDiario.fecha).toDateString() === hoy.toDateString();

    if (!yaPageHoy) {
      chofer.estado = "offline";
      await chofer.save();
      await enviarImagen(
        phone,
        CONFIG.QR_IMAGE_URL,
        `🔔 Para iniciar tu jornada debes pagar *Bs 10* de uso de plataforma.\n\nEscanea el QR y luego envía la *foto del comprobante*.`
      );
      sessions[phone] = { step: "chofer_esperando_comprobante" };
      return;
    }

    chofer.estado = "libre";
    await chofer.save();
    await enviarMensaje(phone, "✅ Estado: *LIBRE*\nYa puedes recibir viajes. 🚖");
    return;
  }

  if (texto === "OCUPADO") {
    chofer.estado = "ocupado";
    await chofer.save();
    await enviarMensaje(phone, "🔴 Estado: *OCUPADO*");
    return;
  }

  // Mensaje para pasajero
  if (mensaje.toUpperCase().startsWith("MSG ")) {
    const msgTexto = mensaje.substring(4).trim();
    const viajeActivo = Object.entries(sessions).find(
      ([, s]) =>
        (s.step === "en_curso" || s.step === "esperando_chofer") &&
        s.choferId === chofer.wialonId
    );
    if (viajeActivo) {
      const [userPhone] = viajeActivo;
      await enviarMensaje(userPhone, `💬 *Mensaje de tu chofer:*\n${msgTexto}`);
      await enviarMensaje(phone, "✅ Mensaje enviado al pasajero.");
    } else {
      await enviarMensaje(phone, "No tienes un viaje activo para enviar mensajes.");
    }
    return;
  }

  // Comprobante de pago (foto)
  if (sessions[phone]?.step === "chofer_esperando_comprobante") {
    // El chofer envió foto del comprobante
    chofer.pagoDiario = {
      fecha: new Date(),
      pagado: true,
      aprobado: false,
    };
    await chofer.save();
    delete sessions[phone];

    // Notificar al admin
    await enviarBotones(
      CONFIG.ADMIN_PHONE,
      `💰 *Comprobante de pago recibido*\n\n` +
        `👤 Chofer: ${chofer.nombre}\n` +
        `🚗 Placa: ${chofer.placa}\n` +
        `📞 Tel: ${phone}\n\n` +
        `¿Aprobar pago?`,
      [{ id: `aprobar_pago_${phone}`, title: "✅ Aprobar" }]
    );

    await enviarMensaje(phone, "✅ Comprobante recibido. Esperando aprobación del administrador...");
    return;
  }

  await enviarMensaje(
    phone,
    `Comandos disponibles:\n` +
      `• *LIBRE* → Disponible para viajes\n` +
      `• *OCUPADO* → No disponible\n` +
      `• *MSG <texto>* → Enviar mensaje al pasajero`
  );
}

// ─── PROCESAR MENSAJE USUARIO ─────────────────────────────────────────────────
async function procesarMensajeUsuario(phone, mensaje, buttonId) {
  let usuario = await Usuario.findOne({ phone });

  // — Términos y condiciones —
  if (!usuario || !usuario.aceptoTerminos) {
    if (!sessions[phone]) sessions[phone] = { step: "usuario_terminos" };
    const session = sessions[phone];

    // Preguntar si es pasajero o chofer la primera vez
    if (session.step === "usuario_terminos" && !buttonId) {
      await enviarBotones(
        phone,
        "👋 ¡Bienvenido a *ChatGo*!\n\n¿Cómo quieres usar la plataforma?",
        [
          { id: "soy_pasajero", title: "🧍 Soy pasajero" },
          { id: "soy_chofer", title: "🚖 Soy chofer" },
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
      // Si es pasajero continua al flujo normal de TyC
      session.step = "usuario_terminos";
    }

    if (session.step === "usuario_terminos" || buttonId === "soy_pasajero") {
      await enviarBotones(
        phone,
        `👋 Bienvenido a *ChatGo* de Lukmi S.R.L.\n\n` +
          `Antes de continuar debes aceptar nuestros Términos y Condiciones:\n\n` +
          `• ChatGo es un servicio de intermediación tecnológica.\n` +
          `• Tu número y ubicación GPS se usan solo para coordinar el viaje.\n` +
          `• No compartimos tu info con terceros para publicidad.\n` +
          `• El pago se realiza directamente al conductor.\n` +
          `• Queda prohibido el uso inapropiado del bot.\n` +
          `• Jurisdicción: Cochabamba, Bolivia.\n\n` +
          `¿Aceptas los términos y condiciones?`,
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
        await enviarMensaje(phone, "Para usar ChatGo debes aceptar los términos. Escribe cualquier mensaje para intentar de nuevo.");
        delete sessions[phone];
      }
      return;
    }
  }

  if (!sessions[phone]) sessions[phone] = { step: "inicio" };
  const session = sessions[phone];

  const coords = mensaje.location
    ? { lat: mensaje.location.latitude, lng: mensaje.location.longitude }
    : null;

  const texto = mensaje.text?.body?.trim() || "";

  // — Mensaje para chofer —
  if (texto.toUpperCase().startsWith("MSG ") && session.step === "en_curso") {
    const msgTexto = texto.substring(4).trim();
    if (session.choferPhone) {
      await enviarMensaje(session.choferPhone, `💬 *Mensaje del pasajero:*\n${msgTexto}`);
      await enviarMensaje(phone, "✅ Mensaje enviado a tu chofer.");
    }
    return;
  }

  // — Audio de voz —
  if (mensaje.type === "audio" || mensaje.type === "voice") {
    await enviarMensaje(phone, "🎤 Procesando tu mensaje de voz...");
    try {
      const audioUrl = await obtenerUrlMedia(mensaje.audio?.id || mensaje.voice?.id);
      const transcripcion = await transcribirAudio(audioUrl);
      await enviarMensaje(phone, `🎤 Escuché: _"${transcripcion}"_\n\n⏳ Buscando ubicaciones...`);

      const ubicaciones = await extraerUbicaciones(transcripcion);

      if (!ubicaciones.origen || !ubicaciones.destino) {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "No pude identificar las ubicaciones. Por favor envía tu 📍 *ubicación de origen* usando el pin de WhatsApp.");
        return;
      }

      const origenCoords = await geocodificarDireccion(ubicaciones.origen);
      const destinoCoords = await geocodificarDireccion(ubicaciones.destino);

      if (!origenCoords || !destinoCoords) {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "No encontré esas ubicaciones en el mapa. Por favor envía tu 📍 *ubicación de origen* con el pin de WhatsApp.");
        return;
      }

      session.origen = origenCoords;
      session.destino = destinoCoords;

      await procesarCalculoViaje(phone, session);
    } catch (e) {
      console.error("Error procesando audio:", e.message);
      await enviarMensaje(phone, "❌ Error procesando el audio. Por favor envía tu ubicación con el 📍 pin de WhatsApp.");
      session.step = "esperando_origen";
    }
    return;
  }

  switch (session.step) {
    case "inicio": {
      // Verificar ruta frecuente
      const rutaFrecuente = await verificarRutaFrecuente(phone);
      if (rutaFrecuente) {
        session.rutaFrecuente = rutaFrecuente;
        session.step = "preguntando_ruta_frecuente";
        await enviarBotones(
          phone,
          `👋 ¡Hola! Bienvenido a ChatGo.\n\n¿Vas al mismo lugar de siempre?\n📍 Origen: ${rutaFrecuente.origen.nombre || "Origen habitual"}\n🏁 Destino: ${rutaFrecuente.destino.nombre || "Destino habitual"}`,
          [
            { id: "usar_ruta_frecuente", title: "✅ Sí, ese viaje" },
            { id: "nueva_ruta", title: "📍 Nueva ruta" },
          ]
        );
      } else {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "👋 ¡Hola! Bienvenido a *ChatGo*.\n\n📍 Envía tu *ubicación de origen* usando el 📎 adjunto → Ubicación.\n\nTambién puedes enviar un 🎤 *mensaje de voz* diciendo a dónde quieres ir.");
      }
      break;
    }

    case "preguntando_ruta_frecuente": {
      if (buttonId === "usar_ruta_frecuente") {
        session.origen = session.rutaFrecuente.origen;
        session.destino = session.rutaFrecuente.destino;
        await procesarCalculoViaje(phone, session);
      } else {
        session.step = "esperando_origen";
        await enviarMensaje(phone, "📍 Envía tu *ubicación de origen* usando el 📎 adjunto → Ubicación.");
      }
      break;
    }

    case "esperando_origen": {
      if (!coords) {
        await enviarMensaje(phone, "Por favor envía tu ubicación usando el 📎 adjunto → Ubicación.\nTambién puedes enviar un 🎤 mensaje de voz.");
        break;
      }
      session.origen = coords;
      session.step = "esperando_destino";
      await enviarMensaje(phone, "✅ Origen recibido.\n\n🏁 Ahora envía tu *ubicación de destino*.");
      break;
    }

    case "esperando_destino": {
      if (!coords) {
        await enviarMensaje(phone, "Por favor envía tu ubicación de destino usando el 📎 adjunto → Ubicación.");
        break;
      }
      session.destino = coords;
      try {
        const dir = await obtenerDireccion(coords.lat, coords.lng);
        if (dir) session.destino.nombre = dir;
      } catch(e) {}
      await procesarCalculoViaje(phone, session);
      break;
    }

    case "sin_chofer": {
      // Usuario recibió recordatorio de chofer disponible
      if (buttonId === "confirmar_viaje_recordatorio") {
        await enviarMensaje(phone, "✅ Perfecto! Buscando tu chofer...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje") {
        delete sessions[phone];
        await enviarMensaje(phone, "❌ Entendido. Escribe cuando necesites taxi. 🚖");
      } else {
        await enviarMensaje(phone, "⏳ Seguimos buscando un móvil para ti...");
      }
      break;
    }

    case "esperando_confirmacion": {
      if (buttonId === "confirmar_viaje") {
        session.step = "confirmado";
        await enviarMensaje(phone, "✅ Viaje confirmado. Buscando chofer cerca de ti...");
        await asignarChofer(phone, session);
      } else if (buttonId === "cancelar_viaje") {
        delete sessions[phone];
        await enviarMensaje(phone, "❌ Viaje cancelado.\nEscribe cualquier mensaje cuando quieras pedir otro taxi.");
      }
      break;
    }

    case "esperando_chofer":
      await enviarMensaje(phone, "⏳ Ya estamos buscando tu chofer. Por favor espera...");
      break;

    case "en_curso":
      await enviarMensaje(phone, "🚖 Tu viaje está en curso.\n💬 Para enviar un mensaje a tu chofer escribe:\n*MSG tu mensaje aquí*");
      break;

    default:
      delete sessions[phone];
      sessions[phone] = { step: "inicio" };
      await procesarMensajeUsuario(phone, mensaje, buttonId);
  }
}

// ─── CALCULAR Y MOSTRAR PRECIO ────────────────────────────────────────────────
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

    await enviarBotones(
      phone,
      `🗺️ *Resumen del viaje*\n\n` +
        `📏 Distancia: ${km} km\n` +
        `⏱️ Tiempo estimado: ${duracion}\n` +
        `💲 Tarifa: Bs ${precioPorKm}/km\n` +
        `💰 *Precio total: Bs ${total}*\n\n` +
        `¿Confirmas el viaje?`,
      [
        { id: "confirmar_viaje", title: "✅ Confirmar" },
        { id: "cancelar_viaje", title: "❌ Cancelar" },
      ]
    );
  } catch (e) {
    console.error("Error calculando viaje:", e.message);
    await enviarMensaje(phone, "❌ Error calculando la ruta. Por favor intenta de nuevo.");
    session.step = "esperando_origen";
  }
}

// ─── WEBHOOK META ─────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === CONFIG.VERIFY_TOKEN
  ) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      const phone = msg.from;
      const buttonId = msg.interactive?.button_reply?.id || null;
      const texto = msg.text?.body?.trim().toUpperCase() || "";

      // Determinar si es chofer
      const esChofer = await Chofer.exists({ phone });
      const esRegistroChofer =
        texto.toUpperCase() === "CHOFER" ||
        texto.toUpperCase() === "SOY CHOFER" ||
        texto.toUpperCase() === "CONDUCTOR" ||
        (sessions[phone] && sessions[phone].step?.startsWith("chofer_"));

      if (esChofer || esRegistroChofer) {
        await procesarMensajeChofer(phone, msg.text?.body || "", buttonId);
      } else {
        await procesarMensajeUsuario(phone, msg, buttonId);
      }
    }
  } catch (e) {
    console.error("Error webhook:", e.message);
  }
});

// ─── INICIAR ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚖 ChatGo corriendo en puerto ${PORT}`));
