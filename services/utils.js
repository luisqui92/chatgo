// ChatGo — Utilidades generales
const { CONFIG, log } = require("../config");
const crypto = require("crypto");
const os = require("os");
const { CodigoPromo, Usuario, Viaje } = require("../db/models");

function fechaStrBolivia(date = new Date()) {
  const t = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

function horaStrBolivia(date = new Date()) {
  const t = new Date(date.getTime() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000);
  return t.toISOString().slice(0, 13);
}

function formatearFechaPromo(fechaStr) {
  if (!fechaStr) return "fin de la promo";
  const [, mm, dd] = fechaStr.split("-");
  const meses = ["enero","febrero","marzo","abril","mayo","junio",
                 "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `${parseInt(dd, 10)} de ${meses[parseInt(mm, 10) - 1] || mm}`;
}

function promoCodigosActiva() {
  return fechaStrBolivia() <= CONFIG.PROMO_CODIGOS_HASTA;
}

async function generarCodigoUnico(maxIntentos = 10) {
  for (let i = 0; i < maxIntentos; i++) {
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    const codigo = `CHATGO-${random}`;
    if (!(await CodigoPromo.findOne({ codigo }))) return codigo;
  }
  return `CHATGO-${Date.now().toString(36).toUpperCase()}`;
}

async function crearCodigoPromo(generadoPorPhone, tipoOrigen = "post_viaje") {
  if (!promoCodigosActiva()) return null;
  const codigo = await generarCodigoUnico();
  const fechaVenc = new Date(Date.now() + CONFIG.CODIGO_VIGENCIA_DIAS * 24 * 60 * 60 * 1000);
  const doc = await CodigoPromo.create({
    codigo,
    descuentoPorcentaje: CONFIG.CODIGO_DESCUENTO_PORCENTAJE,
    generadoPor: generadoPorPhone,
    tipoOrigen,
    fechaVencimiento: fechaVenc,
  });
  log.info(`[PROMO] Código creado: ${codigo} (${tipoOrigen}) para ${generadoPorPhone}`);
  return doc;
}

async function validarCodigoPromo(codigoTexto, precioBase) {
  if (!codigoTexto) return { valido: false, motivo: "Código vacío" };
  const codigo = String(codigoTexto).trim().toUpperCase();
  const doc = await CodigoPromo.findOne({ codigo });
  if (!doc) return { valido: false, motivo: "Ese código no existe" };
  if (doc.usado) return { valido: false, motivo: "Ese código ya fue usado" };
  if (doc.fechaVencimiento < new Date()) return { valido: false, motivo: "El código está vencido" };
  const descuento = Math.round((precioBase * doc.descuentoPorcentaje) / 100);
  return {
    valido: true,
    descuento,
    porcentaje: doc.descuentoPorcentaje,
    codigoDoc: doc,
    nuevoPrecio: Math.max(precioBase - descuento, 1),
  };
}

async function consumirCodigoPromo(codigoDocId, usadoPorPhone, viajeId) {
  await CodigoPromo.findByIdAndUpdate(codigoDocId, {
    usado: true,
    usadoPor: usadoPorPhone,
    fechaUso: new Date(),
    viajeIdAsociado: String(viajeId || ""),
  });
}

function mensajeCodigoEntregado(codigo, motivoTexto = "tu próximo viaje") {
  return (
    `🎁 *¡Tienes un código de descuento!*\n\n` +
    `Descuento: *${codigo.descuentoPorcentaje}% OFF*\n` +
    `Válido por *${CONFIG.CODIGO_VIGENCIA_DIAS} días*\n\n` +
    `📲 Úsalo en ${motivoTexto}.\n` +
    `🤝 También puedes compartirlo con amigos — solo se puede usar 1 vez.\n\n` +
    `Para canjearlo, al confirmar tu próximo viaje toca *🎁 Tengo código*.\n\n` +
    `👇 Tu código (toca para copiar):`
  );
}

// Envía el código en 2 mensajes: explicación + el código SOLO (para copiar/pegar
// limpio en WhatsApp con un toque sostenido).

async function enviarCodigoDescuento(phone, codigo, motivoTexto = "tu próximo viaje") {
  await enviarMensaje(phone, mensajeCodigoEntregado(codigo, motivoTexto));
  // Mensaje separado: SOLO el código, sin nada más, para copiar de un toque
  await enviarMensaje(phone, `${codigo.codigo}`);
}

function validarPlaca(p) {
  if (!p) return false;
  const limpia = String(p).replace(/[\s\-\.]/g, "").toUpperCase();
  return /^(\d{3,4}[A-Z]{3}|[A-Z]{3}\d{3,4})$/.test(limpia);
}

function normalizarPlaca(p) {
  if (!p) return "";
  return String(p).replace(/[\s\-\.]/g, "").toUpperCase();
}

function acortarParaBoton(texto, maxLen = 17) {
  if (!texto) return "";
  // Estrategia: tomar la parte más descriptiva del nombre
  // "Av. Heroínas 450, Centro, Cochabamba" → "Av. Heroínas 450"
  // "Hospital Viedma, Cochabamba" → "Hospital Viedma"
  // "Cochabamba, Bolivia" → "Cochabamba" (fallback)
  const partes = String(texto).split(",").map(p => p.trim()).filter(p => p.length > 0);
  // Preferir la primera parte que no sea solo "Cochabamba" o "Bolivia"
  const ignorar = ["cochabamba","bolivia","cbba","departamento de cochabamba"];
  let elegida = partes[0] || texto;
  for (const parte of partes) {
    if (!ignorar.includes(parte.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))) {
      elegida = parte;
      break;
    }
  }
  if (elegida.length <= maxLen) return elegida;
  return elegida.substring(0, maxLen - 1) + "…";
}

function esIntentoCancelar(texto) {
  if (!texto) return false;
  const t = texto.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const patrones = ["cancelar","cancela","cancelalo","cancelado","ya no quiero","ya no","anular","anula"];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.endsWith(" " + p));
}

function esPedidoAyuda(texto) {
  if (!texto) return false;
  const t = texto.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const patrones = ["ayuda","soporte","urgencia","emergencia","hablar con alguien","admin"];
  return patrones.some((p) => t === p || t.startsWith(p + " ") || t.includes(" " + p));
}

// FIX BUG#12 — detectar Plus Code de Google (formato XXXX+XX o XXXX+XXXX)

function esPlusCode(texto) {
  if (!texto) return false;
  return /^[A-Z0-9]{4,8}\+[A-Z0-9]{2,}/.test(texto.trim().toUpperCase());
}

// ─── PRECISIÓN DE REFERENCIAS DE VOZ ────────────────────────────────────────
// Evalúa si una referencia de voz tiene suficiente precisión para ubicar al pasajero
// Una referencia es precisa si incluye intersección, número, o referencia visual específica

function detectarIncompatibilidadMoto(observaciones) {
  if (!observaciones) return null;
  const t = observaciones.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const reglas = [
    { palabras: ["mascota grande","perro grande","perrazo"], razon: "mascota grande" },
    { palabras: ["maleta grande","maletas","valijas","equipaje grande","muchas maletas"], razon: "equipaje grande" },
    { palabras: ["mueble","muebles","sofa","tv grande","televisor","refrigerador","heladera","lavadora"], razon: "muebles/electrodomésticos" },
    { palabras: ["bebe","bebé","embarazada","embarazo","guagua"], razon: "bebé/embarazada" },
    { palabras: ["muletas","silla de ruedas","discapacidad fisica","yeso"], razon: "movilidad reducida" },
    { palabras: ["3 personas","tres personas","4 personas","cuatro personas","varios pasajeros","somos varios"], razon: "más de 1 pasajero" },
    { palabras: ["fragil","vidrio","garrafa","frágil"], razon: "carga frágil" },
    { palabras: ["mucha compra","muchas compras","compras grandes","carga pesada"], razon: "carga grande" },
  ];
  for (const r of reglas) {
    if (r.palabras.some(p => t.includes(p))) return { incompatible: true, razon: r.razon };
  }
  return null;
}

async function obtenerUltimoViaje(phone) {
  return await Viaje.findOne({ usuarioPhone: phone, estado: "completado" }).sort({ fechaFin: -1 }).lean();
}

async function obtenerDestinosFrecuentes(phone, limit = 2) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario?.rutasFrecuentes?.length) return [];
  const mapa = new Map();
  for (const ruta of usuario.rutasFrecuentes) {
    const key = `${(ruta.destino?.lat || 0).toFixed(3)}_${(ruta.destino?.lng || 0).toFixed(3)}`;
    const actual = mapa.get(key);
    if (actual) {
      actual.contador += ruta.contador || 1;
      if ((ruta.destino?.nombre || "").length > (actual.destino.nombre || "").length) actual.destino = ruta.destino;
    } else {
      mapa.set(key, { destino: ruta.destino, contador: ruta.contador || 1 });
    }
  }
  return Array.from(mapa.values())
    .filter(r => r.destino && r.destino.lat && r.destino.lng)
    .sort((a, b) => b.contador - a.contador)
    .slice(0, limit);
}

async function guardarRutaFrecuente(phone, origen, destino) {
  const usuario = await Usuario.findOne({ phone });
  if (!usuario) return;
  const existente = usuario.rutasFrecuentes.find(
    r => Math.abs(r.origen.lat - origen.lat) < 0.001 && Math.abs(r.destino.lat - destino.lat) < 0.001
  );
  if (existente) existente.contador += 1;
  else usuario.rutasFrecuentes.push({ origen, destino, contador: 1 });
  await usuario.save();
}

async function construirBotonesHistorial(phone) {
  const [ultimo, frecuentes] = await Promise.all([obtenerUltimoViaje(phone), obtenerDestinosFrecuentes(phone, 3)]);
  const botones = [];
  const idsParaSession = { rutas: [] };

  // Siempre reservar el último slot para "Nueva ruta"
  // Máximo 2 destinos del historial + 1 botón nueva ruta = 3 total
  const MAX_HISTORIAL = 2;

  if (ultimo && botones.length < MAX_HISTORIAL) {
    const nombreUltimo = acortarParaBoton(ultimo.destino?.nombre || "", 14);
    const titleUltimo = nombreUltimo ? `🔄 ${nombreUltimo}` : "🔄 Último viaje";
    botones.push({ id: "hist_ultimo", title: titleUltimo });
    idsParaSession.ultimo = { origen: ultimo.origen, destino: ultimo.destino };
  }

  let agregados = 0;
  for (let i = 0; i < frecuentes.length && botones.length < MAX_HISTORIAL; i++) {
    const f = frecuentes[i];
    if (
      ultimo?.destino &&
      Math.abs(ultimo.destino.lat - f.destino.lat) < 0.001 &&
      Math.abs(ultimo.destino.lng - f.destino.lng) < 0.001
    ) continue;
    const nombreFrecuente = acortarParaBoton(f.destino.nombre || "", 14);
    const titleFrecuente = nombreFrecuente ? `⭐ ${nombreFrecuente}` : "⭐ Destino guardado";
    botones.push({ id: `hist_freq_${agregados}`, title: titleFrecuente });
    idsParaSession.rutas.push({ destino: f.destino });
    agregados++;
  }

  // Siempre agregar "Nueva ruta" si hay al menos un destino guardado
  if (botones.length > 0) {
    botones.push({ id: "hist_nueva", title: "📍 Nueva ruta" });
  }

  return { botones, idsParaSession };
}


function enPromoGratis() {
  const hoy = fechaStrBolivia().split("T")[0];
  return hoy <= (CONFIG.PROMO_GRATIS_HASTA || "2026-05-25");
}

function choferPagoAlDia(chofer) {
  if (!chofer || !chofer.pagoDiario) return false;
  return chofer.pagoDiario.pagado && chofer.pagoDiario.fechaStr === fechaStrBolivia().split("T")[0];
}


// ─── PROTECCIÓN XSS — escape HTML ───────────────────────────────────────────
function escapeHtml(unsafe) {
  if (unsafe == null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}



// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO DE VOZ — Helpers para esquinas y lugares personales
// ═══════════════════════════════════════════════════════════════════════════

// Normaliza nombre de calle: quita tildes, acentos, "av.", "calle", etc.
function normalizarNombreCalle(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .replace(/[^a-z0-9 ]/g, "")          // quitar puntuación
    .replace(/\b(av|avenida|calle|c|jr|jirón|jiron|pasaje|psje)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Genera llave única de una esquina (las 2 calles ordenadas alfabéticamente)
// Esto hace que "Ayacucho y Sucre" === "Sucre y Ayacucho"
function llaveEsquina(calle1, calle2, zona) {
  const c1 = normalizarNombreCalle(calle1);
  const c2 = normalizarNombreCalle(calle2);
  if (!c1 || !c2) return null;
  const [a, b] = [c1, c2].sort();
  const z = zona ? normalizarNombreCalle(zona) : "";
  return z ? `${a}|${b}|${z}` : `${a}|${b}`;
}

// Buscar una esquina ya mapeada en la BD
async function buscarEsquinaMapeada(calle1, calle2, zona = null) {
  try {
    const { EsquinaMapeada } = require("../db/models");
    // Primero intentar con zona (si fue proporcionada)
    if (zona) {
      const conZona = await EsquinaMapeada.findOne({ llave: llaveEsquina(calle1, calle2, zona) });
      if (conZona) return conZona;
    }
    // Buscar sin zona (cualquier zona)
    const sinZona = await EsquinaMapeada.findOne({ llave: llaveEsquina(calle1, calle2, null) });
    return sinZona;
  } catch (e) { return null; }
}

// Guardar una esquina nueva en memoria compartida
async function guardarEsquina(calle1, calle2, lat, lng, opciones = {}) {
  try {
    const { EsquinaMapeada } = require("../db/models");
    const llave = llaveEsquina(calle1, calle2, opciones.zona);
    if (!llave) return null;
    
    const existente = await EsquinaMapeada.findOne({ llave });
    if (existente) {
      // Ya existe — solo aumentar contador
      existente.usos = (existente.usos || 0) + 1;
      existente.ultimoUso = new Date();
      await existente.save();
      return existente;
    }
    
    return await EsquinaMapeada.create({
      llave,
      calle1: calle1.trim(),
      calle2: calle2.trim(),
      zona: opciones.zona || null,
      ciudad: opciones.ciudad || "Cochabamba",
      lat, lng,
      usos: 1,
      primerUsuario: opciones.phone || null,
      ultimoUso: new Date(),
    });
  } catch (e) { return null; }
}

// Obtener el lugar personal del usuario (casa/trabajo)
async function obtenerLugarPersonal(phone, tipo) {
  try {
    const { Usuario } = require("../db/models");
    const u = await Usuario.findOne({ phone }).lean();
    if (!u || !u.lugaresFrecuentes) return null;
    if (tipo === "casa") return u.lugaresFrecuentes.casa || null;
    if (tipo === "trabajo") return u.lugaresFrecuentes.trabajo || null;
    return null;
  } catch (e) { return null; }
}

// Guardar lugar personal del usuario
async function guardarLugarPersonal(phone, tipo, lat, lng, nombre) {
  try {
    const { Usuario } = require("../db/models");
    const campo = `lugaresFrecuentes.${tipo}`;
    await Usuario.findOneAndUpdate(
      { phone },
      { $set: { [campo]: { lat, lng, nombre } } },
      { upsert: false }
    );
    return true;
  } catch (e) { return false; }
}

// Decide si una referencia necesita más detalle
// Devuelve { vaga: bool, sugerencias: [...] } para guiar al usuario
function evaluarReferencia(detalle) {
  if (!detalle) return { vaga: true, motivo: "sin_datos" };
  
  if (detalle.tipo === "esquina") return { vaga: false };
  if (detalle.tipo === "personal") return { vaga: false };
  
  if (detalle.tipo === "lugar") {
    // Lugares con nombre propio bien específicos
    const lugaresUnicos = [
      "aeropuerto", "wilstermann",
      "terminal de buses", "terminal",
      "hospital viedma", "hospital univalle",
      "cine center", "multicine",
      "mall las americas", "mall plaza",
    ];
    const tx = normalizarNombreCalle(detalle.texto || "");
    const esUnico = lugaresUnicos.some(l => tx.includes(normalizarNombreCalle(l)));
    if (esUnico) return { vaga: false };
    
    // Lugares grandes (UMSS, Estadio, etc.) → vagos, pedir referencia
    const lugaresGrandes = ["umss", "ucb", "upb", "estadio", "capriles", "mercado", "cancha", "plaza colon", "plaza recoleta"];
    const esGrande = lugaresGrandes.some(l => tx.includes(normalizarNombreCalle(l)));
    if (esGrande) return { vaga: true, motivo: "lugar_grande", texto: detalle.texto };
  }
  
  if (detalle.tipo === "vago") return { vaga: true, motivo: "zona_amplia", texto: detalle.texto };
  
  return { vaga: false };
}

// Genera mensaje pidiendo más referencia según el caso
function mensajePidiendoReferencia(detalle, evaluacion, esOrigen = true) {
  const tipoLabel = esOrigen ? "📍 *ORIGEN — de dónde te recogemos*" : "🏁 *DESTINO — a dónde vas*";
  const textoOriginal = detalle.texto || evaluacion.texto || "ese lugar";
  
  if (evaluacion.motivo === "zona_amplia") {
    return `Te entendí: *${textoOriginal}* 🎤\n\n` +
      `Esa zona es grande — necesito una *esquina* o *referencia exacta* para que el chofer te encuentre rápido.\n\n` +
      `${tipoLabel}\n` +
      `🎤 Mandame otro audio con la esquina, por ejemplo:\n` +
      `   • "${textoOriginal} y Av. Heroínas"\n` +
      `   • "${textoOriginal} esquina Pando"\n` +
      `   • "${textoOriginal} al lado de [referencia]"\n\n` +
      `_O si preferís, mandame el 📍 pin de la ubicación exacta._`;
  }
  
  if (evaluacion.motivo === "lugar_grande") {
    return `Te entendí: *${textoOriginal}* 🎤\n\n` +
      `Ese lugar es grande y tiene varias entradas — ¿cuál puerta o zona?\n\n` +
      `${tipoLabel}\n` +
      `🎤 Mandame otro audio con más detalle, por ejemplo:\n` +
      `   • "${textoOriginal} puerta principal"\n` +
      `   • "${textoOriginal} esquina norte"\n` +
      `   • "${textoOriginal} frente a [referencia]"\n\n` +
      `_O mandame el 📍 pin de la ubicación exacta._`;
  }
  
  return `Te entendí: *${textoOriginal}* 🎤\n\nMandame más referencias o el 📍 pin exacto.`;
}



// ─── CÁLCULO DE PRECIO POR TIPO DE VEHÍCULO ─────────────────────────────────
// Tarifas reales Cochabamba 2026:
//  - Auto: Bs 7 base + Bs 3.5 por km (mínimo Bs 8)
//  - Moto: Bs 5 base + Bs 2.5 por km (mínimo Bs 6)
function calcularPrecio(km, tipoVehiculo) {
  const tarifas = {
    auto: { base: 7, porKm: 3.5, minimo: 8 },
    moto: { base: 5, porKm: 2.5, minimo: 6 },
  };
  const t = tarifas[tipoVehiculo] || tarifas.auto;
  const calculado = t.base + (km * t.porKm);
  const total = Math.max(Math.round(calculado), t.minimo);
  return {
    total,
    precioPorKm: t.porKm,
    base: t.base,
  };
}


module.exports = { fechaStrBolivia, horaStrBolivia, formatearFechaPromo, promoCodigosActiva, enPromoGratis, choferPagoAlDia, generarCodigoUnico, crearCodigoPromo, validarCodigoPromo, consumirCodigoPromo, mensajeCodigoEntregado, enviarCodigoDescuento, validarPlaca, normalizarPlaca, acortarParaBoton, esIntentoCancelar, esPedidoAyuda, esPlusCode, detectarIncompatibilidadMoto, obtenerUltimoViaje, obtenerDestinosFrecuentes, guardarRutaFrecuente, construirBotonesHistorial, escapeHtml, normalizarNombreCalle, llaveEsquina, buscarEsquinaMapeada, guardarEsquina, obtenerLugarPersonal, guardarLugarPersonal, evaluarReferencia, mensajePidiendoReferencia, calcularPrecio };
