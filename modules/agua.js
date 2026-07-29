// ChatGo — Módulo Agua de Mesa (ChatGo Agua) 💧
//
// El cliente pide agua por WhatsApp: elige del catálogo, manda su ubicación,
// el método de pago, y el bot despacha el pedido al repartidor de la fábrica y
// le confirma al cliente. Soporta "pedí lo de siempre" (pedido recurrente).
//
// Aditivo y detrás de MODULOS_ACTIVOS ("agua"). Para la demo entra por el número
// de ChatGo; en producción la fábrica puede usar su propio número.

const { CONFIG, log } = require("../config");
const { updateSession, deleteSession } = require("../services/session");
const { enviarMensaje, enviarBotones, enviarImagen } = require("../services/whatsapp");
const { obtenerDireccion } = require("../services/google");
const { textoDeMensaje } = require("./util");
const { Usuario } = require("../db/models");

// ── Catálogo (EDITÁ acá los productos y precios reales de la fábrica) ─────────
const CATALOGO = [
  { key: "dispensador", nombre: "Dispensador eléctrico (frío/caliente)", precio: 150, kw: /dispensador|surtidor|dispenser/i },
  { key: "pack",        nombre: "Pack 12 botellas 600 ml",              precio: 18,  kw: /pack|botellas?|600/i },
  { key: "bidon_nuevo", nombre: "Bidón 20L con envase nuevo",           precio: 45,  kw: /envase nuevo|bid[oó]n nuevo|con envase/i },
  { key: "bidon",       nombre: "Bidón 20L (recarga)",                  precio: 15,  kw: /bid[oó]n|bidones|recarga|20\s*(l|lt|litros)/i },
];
const PAGOS = { efectivo: "💵 Efectivo", qr: "📲 QR", transferencia: "🏦 Transferencia" };

function fabrica() { return CONFIG.AGUA_FABRICA_NOMBRE || "Agua de Mesa"; }
function repartidor() { return CONFIG.AGUA_REPARTIDOR_PHONE || CONFIG.ADMIN_PHONE; }

function catalogoTexto() {
  return "💧 *ChatGo Agua — " + fabrica() + "*\n\n" +
    CATALOGO.map(p => `• ${p.nombre} — *Bs ${p.precio}*`).join("\n") +
    "\n\n¿Qué necesitás? Escribí por ejemplo: *2 bidones* 💧";
}

// Detecta producto + cantidad del texto ("quiero 2 bidones")
function parsePedido(texto) {
  const t = texto || "";
  const qty = t.match(/\b(\d{1,2})\b/);
  const cantidad = qty ? Math.max(1, Math.min(parseInt(qty[1]), 50)) : 1;
  for (const p of CATALOGO) if (p.kw.test(t)) return { key: p.key, nombre: p.nombre, precio: p.precio, cantidad };
  return null;
}
function porKey(key) { return CATALOGO.find(p => p.key === key); }

// ── Despacho: avisa al repartidor y confirma al cliente ──────────────────────
async function despachar(phone, pedido, punto, metodo) {
  const total = pedido.precio * pedido.cantidad;
  const link = `https://www.google.com/maps?q=${punto.lat},${punto.lng}`;

  // Aviso al REPARTIDOR de la fábrica
  await enviarMensaje(repartidor(),
    `💧 *Nuevo pedido de agua — ${fabrica()}*\n\n` +
    `📦 ${pedido.cantidad}× ${pedido.nombre}\n` +
    `💰 Total: *Bs ${total}*\n` +
    `📍 ${punto.nombre || "ver mapa"}\n${link}\n` +
    `💳 Pago: ${PAGOS[metodo] || metodo}\n` +
    `📞 Cliente: +${phone}\n\n` +
    `_Contactá al cliente y llevá el pedido._ 🚚`
  ).catch(() => {});

  // Confirmación al CLIENTE
  await enviarMensaje(phone,
    `✅ *¡Pedido confirmado!* 💧\n\n` +
    `📦 ${pedido.cantidad}× ${pedido.nombre}\n` +
    `💰 Total: *Bs ${total}*\n` +
    `📍 ${punto.nombre || "tu ubicación"}\n` +
    `💳 ${PAGOS[metodo] || metodo}\n\n` +
    `Tu agua ya va en camino. El repartidor te va a contactar. 🚚\n\n` +
    `_Gracias por pedir con ChatGo Agua 💧_`
  );

  // Guardar como "lo de siempre"
  await Usuario.upsert({
    where: { phone },
    update: { ultimoPedidoAgua: { key: pedido.key, cantidad: pedido.cantidad, punto, metodo } },
    create: { phone, ultimoPedidoAgua: { key: pedido.key, cantidad: pedido.cantidad, punto, metodo } },
  }).catch(() => {});

  enviarMensaje(CONFIG.ADMIN_PHONE, `💧 [AGUA] +${phone}: ${pedido.cantidad}× ${pedido.nombre} = Bs ${total} (${metodo}).`).catch(() => {});
  await deleteSession(phone);
  return true;
}

// ── Entrada al módulo ────────────────────────────────────────────────────────
async function iniciar(phone, msg, session) {
  const { texto } = await textoDeMensaje(msg);

  // "pedí lo de siempre" → repetir el último pedido
  if (/lo de siempre|de siempre|lo mismo/i.test(texto || "")) {
    const u = await Usuario.findUnique({ where: { phone } }).catch(() => null);
    const ant = u && u.ultimoPedidoAgua;
    if (ant && ant.key && ant.punto) {
      const prod = porKey(ant.key);
      await updateSession(phone, { ...(session || {}), modulo: "agua", step: "mod_agua_confirmar_siempre", aguaSiempre: ant });
      await enviarBotones(phone,
        `💧 *Lo de siempre:*\n\n📦 ${ant.cantidad}× ${prod ? prod.nombre : ant.key}\n📍 ${ant.punto.nombre || "tu dirección de antes"}\n💳 ${PAGOS[ant.metodo] || ant.metodo}\n\n¿Lo confirmo?`,
        [{ id: "agua_siempre_si", title: "✅ Sí, dale" }, { id: "agua_siempre_no", title: "✏️ Cambiar" }]
      );
      return true;
    }
    // sin historial → sigue al catálogo normal
  }

  // ¿El mensaje ya trae el producto? ("quiero 2 bidones")
  const pedido = parsePedido(texto);
  if (pedido) {
    await updateSession(phone, { ...(session || {}), modulo: "agua", step: "mod_agua_ubicacion", aguaPedido: pedido });
    await enviarMensaje(phone,
      `💧 *${pedido.cantidad}× ${pedido.nombre}* = Bs ${pedido.precio * pedido.cantidad}\n\n` +
      `📍 Mandame tu *ubicación* para la entrega:\n📎 clip → *Ubicación* → *Enviar mi ubicación actual*\n\n_Escribí CANCELAR para salir._`
    );
    return true;
  }

  // Mostrar catálogo
  await updateSession(phone, { ...(session || {}), modulo: "agua", step: "mod_agua_producto" });
  await enviarMensaje(phone, catalogoTexto());
  return true;
}

// ── Procesar pasos ───────────────────────────────────────────────────────────
async function procesar(phone, msg, buttonId, session) {
  const { texto } = await textoDeMensaje(msg);

  if (/^cancelar$/i.test(texto || "")) {
    await deleteSession(phone);
    await enviarMensaje(phone, "❌ Pedido de agua cancelado. Escribí *agua* cuando quieras. 💧");
    return true;
  }

  // Confirmar "lo de siempre"
  if (session.step === "mod_agua_confirmar_siempre") {
    if (buttonId === "agua_siempre_si") {
      const ant = session.aguaSiempre; const prod = porKey(ant.key);
      if (!prod) { await enviarMensaje(phone, catalogoTexto()); await updateSession(phone, { ...session, step: "mod_agua_producto" }); return true; }
      return await despachar(phone, { key: prod.key, nombre: prod.nombre, precio: prod.precio, cantidad: ant.cantidad }, ant.punto, ant.metodo);
    }
    // "Cambiar" → catálogo
    await updateSession(phone, { ...session, step: "mod_agua_producto" });
    await enviarMensaje(phone, catalogoTexto());
    return true;
  }

  // Elegir producto
  if (session.step === "mod_agua_producto") {
    const pedido = parsePedido(texto);
    if (!pedido) { await enviarMensaje(phone, "🤔 No entendí. Escribí por ejemplo *2 bidones* o *un dispensador*.\n\n" + catalogoTexto()); return true; }
    await updateSession(phone, { ...session, step: "mod_agua_ubicacion", aguaPedido: pedido });
    await enviarMensaje(phone,
      `💧 *${pedido.cantidad}× ${pedido.nombre}* = Bs ${pedido.precio * pedido.cantidad}\n\n📍 Mandame tu *ubicación* para la entrega:\n📎 clip → *Ubicación* → *Enviar mi ubicación actual*`
    );
    return true;
  }

  // Ubicación
  if (session.step === "mod_agua_ubicacion") {
    let punto = null;
    if (msg?.location) {
      const lat = parseFloat(msg.location.latitude ?? msg.location.lat);
      const lng = parseFloat(msg.location.longitude ?? msg.location.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        const nombre = msg.location.name || (await obtenerDireccion(lat, lng).catch(() => null)) || "Tu ubicación";
        punto = { lat, lng, nombre };
      }
    }
    if (!punto) { await enviarMensaje(phone, "📍 Necesito tu *ubicación* (el pin): 📎 clip → *Ubicación* → *Enviar mi ubicación actual*."); return true; }
    await updateSession(phone, { ...session, step: "mod_agua_pago", aguaPunto: punto });
    await enviarBotones(phone, "💳 ¿Cómo vas a pagar?", [
      { id: "agua_pago_efectivo", title: "💵 Efectivo" },
      { id: "agua_pago_qr", title: "📲 QR" },
      { id: "agua_pago_transferencia", title: "🏦 Transferencia" },
    ]);
    return true;
  }

  // Método de pago → despacho
  if (session.step === "mod_agua_pago") {
    const metodo = buttonId === "agua_pago_qr" ? "qr" : buttonId === "agua_pago_transferencia" ? "transferencia" : buttonId === "agua_pago_efectivo" ? "efectivo" : null;
    if (!metodo) { await enviarMensaje(phone, "💳 Elegí una opción con los botones: Efectivo, QR o Transferencia."); return true; }
    if (metodo === "qr" && (CONFIG.QR_IMAGE_URL)) {
      await enviarImagen(phone, CONFIG.QR_IMAGE_URL, "📲 Escaneá el QR para pagar. Mostrale el comprobante al repartidor.").catch(() => {});
    }
    return await despachar(phone, session.aguaPedido, session.aguaPunto, metodo);
  }

  await deleteSession(phone);
  return false;
}

module.exports = { id: "agua", iniciar, procesar };
