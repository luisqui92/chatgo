// ChatGo — Módulo DELIVERY inteligente
//
// "tengo 30 bs y quiero pollo" → busca en el catálogo (restaurantes + platos)
// los que entran en el presupuesto, muestra las opciones, el cliente elige,
// manda su pin de entrega, y el pedido se despacha con el MOTOR DEL TAXI:
// origen = el restaurante, destino = el cliente, y el repartidor ve en las
// observaciones qué recoger. Sin catálogo cargado (o sin match), cae al modo
// manual: guarda la solicitud y avisa al admin.
//
// Flujo: pedido (antojo + presupuesto) → opciones numeradas → elegir →
//        pin de entrega → resumen (plato + envío) → confirmar → despacho

const { CONFIG, log } = require("../config");
const { Restaurante, Plato, Solicitud } = require("../db/models");
const { getSession, updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones } = require("../services/whatsapp");
const { calcularDistancia, obtenerDireccion } = require("../services/google");
const { calcularPrecio } = require("../services/utils");
const { asignarChofer } = require("../flows/viaje");
const { textoDeMensaje } = require("./util");

// ─── Búsqueda por antojo + presupuesto (determinista, sin latencia) ─────────
const STOPWORDS = new Set(["tengo","quiero","quisiera","hay","de","del","la","el","los","las","un","una","unos","unas","y","con","para","por","que","me","mi","solo","nomas","nomás","bs","bolivianos","pesos","algo","comer","pedir","delivery","comida"]);

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Números hablados frecuentes ("tengo treinta bolivianos" — caso real de audio)
const NUMEROS_PALABRA = { diez: 10, quince: 15, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100 };

// "tengo 30 bs y quiero pollo" → { presupuesto: 30, terminos: ["pollo"] }
function interpretarPedido(texto) {
  let t = norm(texto);
  // Convertir números en palabras a dígitos antes de extraer el monto
  for (const [palabra, valor] of Object.entries(NUMEROS_PALABRA)) {
    t = t.replace(new RegExp(`\\b${palabra}\\b`, "g"), String(valor));
  }
  const mMonto = t.match(/(\d{1,4})\s*(bs|bolivianos|pesos)?\b/);
  const presupuesto = mMonto ? parseInt(mMonto[1], 10) : null;
  const terminos = t
    .replace(/\d+/g, " ")
    .split(/[^a-zñ]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
  return { presupuesto, terminos };
}

async function buscarOpciones(terminos, presupuesto) {
  const platos = await Plato.findMany({
    where: { activo: true, restaurante: { activo: true } },
    include: { restaurante: true },
    take: 500,
  });
  const puntuados = [];
  for (const p of platos) {
    const texto = norm(`${p.nombre} ${p.etiquetas || ""} ${p.restaurante.nombre} ${p.restaurante.categorias || ""}`);
    const hits = terminos.filter(term => texto.includes(term)).length;
    // Sin términos ("delivery" a secas) todo califica; con términos, exigir al menos 1 hit
    if (terminos.length > 0 && hits === 0) continue;
    if (presupuesto && p.precioBs > presupuesto) continue;
    puntuados.push({ p, hits });
  }
  puntuados.sort((a, b) => b.hits - a.hits || a.p.precioBs - b.p.precioBs);
  return puntuados.slice(0, 5).map(x => x.p);
}

function listarOpciones(opciones, presupuesto) {
  const lineas = opciones.map((p, i) =>
    `*${i + 1}.* ${p.nombre} — *Bs ${p.precioBs}*\n   🏪 ${p.restaurante.nombre}${p.restaurante.zona ? ` (${p.restaurante.zona})` : ""}${p.descripcion ? `\n   _${p.descripcion}_` : ""}`
  );
  return `🍔 *Esto encontré${presupuesto ? ` hasta Bs ${presupuesto}` : ""}:*\n\n` +
    lineas.join("\n\n") +
    `\n\n👉 Respondé con el *número* de tu elección (1-${opciones.length}), o escribí otro antojo.\n_Escribe CANCELAR para salir._`;
}

// ─── Modo manual (sin catálogo o sin match): captura + admin ────────────────
async function capturaManual(phone, pedidoTexto, session) {
  await updateSession(phone, { ...session, modulo: "delivery", step: "mod_delivery_zona_manual", deliveryPedido: pedidoTexto });
  await enviarMensaje(phone, "📍 ¿En qué zona estás? Mandame tu ubicación (pin) o escribila.");
}

async function iniciar(phone, msg, session) {
  const base = { ...(session || {}), modulo: "delivery", step: "mod_delivery_pedido" };
  // Si el mensaje de entrada YA trae el antojo ("tengo 30 bs y quiero pollo"),
  // procesarlo directo — no volver a preguntar lo que acaba de decir
  const { texto } = await textoDeMensaje(msg);
  if (texto && !/^(delivery|comida|restaurantes?)$/i.test(texto.trim())) {
    await updateSession(phone, base);
    return await procesar(phone, msg, null, base);
  }
  await enviarMensaje(phone,
    "🍔 *ChatGo Delivery*\n\n¿Qué se te antoja y cuánto tenés?\n\n_Ej: \"un pollo entero, tengo 60 bs\" — o escribí solo el antojo._\n\nEscribe CANCELAR para salir.");
  await updateSession(phone, base);
  return true;
}

async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto) || buttonId === "mod_delivery_cancelar") {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Pedido cancelado. Escribe *delivery* cuando tengas antojo. 🍔");
    return true;
  }

  switch (session.step) {

    // ── 1. Antojo + presupuesto → opciones del catálogo ─────────────────────
    case "mod_delivery_pedido": {
      if (!texto) { await enviarMensaje(phone, "🙏 Contame qué se te antoja (texto o audio)."); return true; }
      const { presupuesto, terminos } = interpretarPedido(texto);
      const opciones = await buscarOpciones(terminos, presupuesto).catch(() => []);

      if (!opciones.length) {
        // Sin catálogo o sin match → modo manual (operador humano)
        await enviarMensaje(phone, `😕 No encontré opciones${presupuesto ? ` hasta Bs ${presupuesto}` : ""} para eso en nuestros locales asociados.\n\nIgual te ayudamos a mano 💪`);
        await capturaManual(phone, texto, session);
        return true;
      }

      await updateSession(phone, {
        ...session,
        step: "mod_delivery_eligiendo",
        deliveryPedido: texto,
        deliveryPresupuesto: presupuesto,
        deliveryOpciones: opciones.map(p => ({
          platoId: p.id, nombre: p.nombre, precio: p.precioBs,
          restNombre: p.restaurante.nombre, restId: p.restaurante.id,
          restLat: p.restaurante.lat, restLng: p.restaurante.lng,
          restTelefono: p.restaurante.telefono || null,
        })),
      });
      await enviarMensaje(phone, listarOpciones(opciones, presupuesto));
      return true;
    }

    // ── 2. Elegir opción por número ──────────────────────────────────────────
    case "mod_delivery_eligiendo": {
      const n = parseInt(texto, 10);
      const opciones = session.deliveryOpciones || [];
      if (isNaN(n) || n < 1 || n > opciones.length) {
        // Texto no numérico: lo tratamos como un antojo nuevo
        return await procesar(phone, msg, buttonId, { ...session, step: "mod_delivery_pedido" });
      }
      const eleccion = opciones[n - 1];
      await updateSession(phone, { ...session, step: "mod_delivery_entrega", deliveryEleccion: eleccion });
      await enviarMensaje(phone,
        `✅ *${eleccion.nombre}* de *${eleccion.restNombre}* — Bs ${eleccion.precio}\n\n📍 ¿*Dónde te lo llevamos*? Mandame tu ubicación (pin de WhatsApp).`);
      return true;
    }

    // ── 3. Pin de entrega → cotizar envío ────────────────────────────────────
    case "mod_delivery_entrega": {
      const lat = parseFloat(msg?.location?.latitude ?? msg?.location?.lat);
      const lng = parseFloat(msg?.location?.longitude ?? msg?.location?.lng);
      if (isNaN(lat) || isNaN(lng)) {
        await enviarMensaje(phone, "📍 Necesito tu ubicación exacta: 📎 → *Ubicación* → *Enviar mi ubicación actual*.");
        return true;
      }
      const el = session.deliveryEleccion;
      const nombreEntrega = (await obtenerDireccion(lat, lng).catch(() => null)) || "Tu ubicación";

      // Envío: tarifa de moto por distancia real desde el restaurante (si tiene coords)
      let envio = 7, km = null;
      if (el.restLat && el.restLng) {
        const d = await calcularDistancia({ lat: el.restLat, lng: el.restLng }, { lat, lng }).catch(() => null);
        if (d?.km) { km = d.km; envio = Math.max(7, calcularPrecio(d.km, "moto").total); }
      }
      const total = Math.round(el.precio + envio);

      await updateSession(phone, {
        ...session,
        step: "mod_delivery_confirmar",
        deliveryEntrega: { lat, lng, nombre: nombreEntrega },
        deliveryEnvio: envio, deliveryKm: km, deliveryTotal: total,
      });
      await enviarBotones(phone,
        `🧾 *Resumen del pedido*\n\n🍽️ ${el.nombre} — Bs ${el.precio}\n🏪 ${el.restNombre}\n🛵 Envío${km ? ` (${km} km)` : ""} — Bs ${envio}\n📍 Entrega: ${nombreEntrega}\n\n💰 *Total: Bs ${total}* (pagás al recibir)`,
        [
          { id: "mod_delivery_si", title: "✅ Confirmar pedido" },
          { id: "mod_delivery_cancelar", title: "❌ Cancelar" },
        ]);
      return true;
    }

    // ── 4. Confirmar → guardar + despachar repartidor con el motor del taxi ──
    case "mod_delivery_confirmar": {
      if (buttonId !== "mod_delivery_si" && !/^(si|sí|confirmar|ok|dale)$/i.test(texto)) {
        await enviarMensaje(phone, "Tocá *Confirmar pedido* o escribí *CANCELAR*.");
        return true;
      }
      const el = session.deliveryEleccion;
      const entrega = session.deliveryEntrega;

      let solicitudId = null;
      try {
        const sol = await Solicitud.create({
          data: {
            tipo: "delivery",
            usuarioPhone: phone,
            estado: "confirmada",
            detalle: {
              plato: el.nombre, precioPlato: el.precio, restaurante: el.restNombre,
              restauranteId: el.restId, envio: session.deliveryEnvio, total: session.deliveryTotal,
            },
            origenLat: el.restLat, origenLng: el.restLng, origenNombre: el.restNombre,
            destinoLat: entrega.lat, destinoLng: entrega.lng, destinoNombre: entrega.nombre,
            precioBs: session.deliveryTotal,
          },
        });
        solicitudId = sol.id;
      } catch (e) { log.error("[MOD:delivery] Error guardando solicitud:", e.message); }

      // Avisar al admin SIEMPRE (para coordinar con el restaurante)
      enviarMensaje(CONFIG.ADMIN_PHONE,
        `🍔 *PEDIDO DELIVERY*\n👤 +${phone}\n🍽️ ${el.nombre} (Bs ${el.precio})\n🏪 ${el.restNombre}${el.restTelefono ? ` · 📞 +${el.restTelefono}` : ""}\n🛵 Envío Bs ${session.deliveryEnvio} · Total Bs ${session.deliveryTotal}\n📍 ${entrega.nombre}${solicitudId ? `\n🆔 ${solicitudId}` : ""}`).catch(() => {});

      // Despacho con el motor del taxi (si el restaurante tiene coordenadas):
      // origen = restaurante, destino = cliente, el repartidor ve qué recoger
      if (el.restLat && el.restLng) {
        const sesionViaje = {
          step: "calculando",
          origen: { lat: el.restLat, lng: el.restLng, nombre: `🏪 ${el.restNombre}` },
          destino: { lat: entrega.lat, lng: entrega.lng, nombre: entrega.nombre },
          ubicaciones: { origen: { lat: el.restLat, lng: el.restLng }, destino: { lat: entrega.lat, lng: entrega.lng } },
          distancia: session.deliveryKm || 0,
          precio: session.deliveryEnvio,
          precioBase: session.deliveryEnvio,
          observaciones: `🍔 DELIVERY: recoger "${el.nombre}" en ${el.restNombre} y entregar al cliente. El cliente paga Bs ${session.deliveryTotal} al recibir (Bs ${el.precio} del pedido + Bs ${session.deliveryEnvio} del envío).`,
          tipoVehiculoSolicitado: null,
          esDelivery: true,
          solicitudId,
        };
        await updateSession(phone, sesionViaje);
        await asignarChofer(phone, sesionViaje);
        try {
          if (solicitudId) {
            const s = await getSession(phone);
            if (s?.viajeId) await Solicitud.update({ where: { id: solicitudId }, data: { viajeId: s.viajeId, estado: "asignada" } });
          }
        } catch (e) { log.error("[MOD:delivery] Error vinculando viaje:", e.message); }
      } else {
        await deleteSession(phone);
        await enviarMensaje(phone, "🍔 *¡Pedido confirmado!* Un operador de ChatGo lo está coordinando con el local y te avisamos en breve.");
      }
      return true;
    }

    // ── Modo manual: zona (sin catálogo) ─────────────────────────────────────
    case "mod_delivery_zona_manual": {
      let zona = texto;
      const lat = parseFloat(msg?.location?.latitude ?? msg?.location?.lat);
      const lng = parseFloat(msg?.location?.longitude ?? msg?.location?.lng);
      let coords = null;
      if (!isNaN(lat) && !isNaN(lng)) {
        coords = { lat, lng };
        zona = (await obtenerDireccion(lat, lng).catch(() => null)) || "Pin recibido";
      }
      if (!zona) { await enviarMensaje(phone, "📍 Mandame tu ubicación o escribí la zona."); return true; }

      let solicitudId = null;
      try {
        const sol = await Solicitud.create({
          data: {
            tipo: "delivery", usuarioPhone: phone, estado: "nueva",
            detalle: { pedido: session.deliveryPedido, zona },
            origenLat: coords?.lat ?? null, origenLng: coords?.lng ?? null, origenNombre: zona,
          },
        });
        solicitudId = sol.id;
      } catch (e) { log.error("[MOD:delivery] Error guardando manual:", e.message); }

      await deleteSession(phone);
      await enviarMensaje(phone, "🛵 ¡Listo! Un operador de ChatGo está buscando las mejores opciones para tu pedido y te escribe en unos minutos.");
      enviarMensaje(CONFIG.ADMIN_PHONE,
        `🆕 *Solicitud DELIVERY (manual)*\n👤 +${phone}\n🍽️ ${session.deliveryPedido}\n📍 ${zona}${solicitudId ? `\n🆔 ${solicitudId}` : ""}`).catch(() => {});
      return true;
    }

    default:
      await deleteSession(phone);
      return false;
  }
}

module.exports = { id: "delivery", iniciar, procesar };
