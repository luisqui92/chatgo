// ChatGo — Utilidades generales
const { CONFIG, log } = require("../config");
const crypto = require("crypto");
const os = require("os");
const { CodigoPromo, Usuario, Viaje } = require("../db/models");
const { enviarMensaje } = require("../services/whatsapp");

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
    if (!(await CodigoPromo.findUnique({ where: { codigo } }))) return codigo;
  }
  return `CHATGO-${Date.now().toString(36).toUpperCase()}`;
}

async function crearCodigoPromo(generadoPorPhone, tipoOrigen = "post_viaje") {
  if (!promoCodigosActiva()) return null;
  const codigo = await generarCodigoUnico();
  const fechaVenc = new Date(Date.now() + CONFIG.CODIGO_VIGENCIA_DIAS * 24 * 60 * 60 * 1000);
  const doc = await CodigoPromo.create({
    data: {
      codigo,
      descuentoPorcentaje: CONFIG.CODIGO_DESCUENTO_PORCENTAJE,
      generadoPor: generadoPorPhone,
      tipoOrigen,
      fechaVencimiento: fechaVenc,
    },
  });
  log.info(`[PROMO] Código creado: ${codigo} (${tipoOrigen}) para ${generadoPorPhone}`);
  return doc;
}

async function validarCodigoPromo(codigoTexto, precioBase) {
  if (!codigoTexto) return { valido: false, motivo: "Código vacío" };
  const codigo = String(codigoTexto).trim().toUpperCase();
  const doc = await CodigoPromo.findUnique({ where: { codigo } });
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
  await CodigoPromo.update({
    where: { id: codigoDocId },
    data: {
      usado: true,
      usadoPor: usadoPorPhone,
      fechaUso: new Date(),
      viajeIdAsociado: String(viajeId || ""),
    },
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
  return await Viaje.findFirst({
    where: { usuarioPhone: phone, estado: "completado" },
    orderBy: { fechaFin: "desc" },
  });
}

async function obtenerDestinosFrecuentes(phone, limit = 2) {
  const usuario = await Usuario.findUnique({ where: { phone } });
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

async function guardarRutaFrecuente(phone, origen, destino, tipoVehiculo = "auto") {
  const usuario = await Usuario.findUnique({ where: { phone } });
  if (!usuario) return;
  // Hora actual en Bolivia (0-23)
  const horaBolivia = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000).getUTCHours();
  const rutasFrecuentes = usuario.rutasFrecuentes || [];
  const existente = rutasFrecuentes.find(
    r => Math.abs(r.origen.lat - origen.lat) < 0.001 && Math.abs(r.destino.lat - destino.lat) < 0.001
  );
  if (existente) {
    existente.contador += 1;
    existente.horas = existente.horas || [];
    existente.horas.push(horaBolivia);
    // Mantener máximo 50 registros de hora por ruta (evita crecimiento infinito)
    if (existente.horas.length > 50) existente.horas = existente.horas.slice(-50);
    existente.tipoVehiculo = tipoVehiculo;
    existente.ultimoViaje = new Date();
  } else {
    rutasFrecuentes.push({
      origen, destino, contador: 1,
      horas: [horaBolivia], tipoVehiculo, ultimoViaje: new Date(),
    });
  }
  await Usuario.update({ where: { phone }, data: { rutasFrecuentes } });
}

// ─── COPILOTO DE HÁBITOS: sugerencia inteligente por hora ────────────────────
// Analiza las rutas frecuentes del usuario y, si detecta un patrón en la hora
// actual, devuelve una sugerencia lista para ofrecer. Si no hay patrón, null.
async function sugerenciaPorHora(phone) {
  try {
    const usuario = await Usuario.findUnique({ where: { phone } });
    if (!usuario?.rutasFrecuentes?.length) return null;

    const horaActual = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000).getUTCHours();

    let mejor = null;
    let mejorPuntaje = 0;

    for (const ruta of usuario.rutasFrecuentes) {
      if (!ruta.destino?.lat || !ruta.horas?.length) continue;
      // Contar cuántas veces se hizo este viaje en una ventana de ±1 hora de la actual
      const enVentana = ruta.horas.filter(h => {
        const diff = Math.min(
          Math.abs(h - horaActual),
          24 - Math.abs(h - horaActual) // diferencia circular (23 y 0 están cerca)
        );
        return diff <= 1;
      }).length;

      // Requisito para sugerir: al menos 2 viajes en esta franja horaria
      if (enVentana >= 2 && enVentana > mejorPuntaje) {
        mejorPuntaje = enVentana;
        mejor = ruta;
      }
    }

    if (!mejor) return null;
    return {
      origen: mejor.origen,
      destino: mejor.destino,
      tipoVehiculo: mejor.tipoVehiculo || "auto",
      veces: mejorPuntaje,
      destinoNombre: mejor.destino.nombre || "tu destino habitual",
    };
  } catch (e) {
    return null;
  }
}

async function construirBotonesHistorial(phone) {
  const [ultimo, frecuentes] = await Promise.all([obtenerUltimoViaje(phone), obtenerDestinosFrecuentes(phone, 3)]);
  const botones = [];
  const idsParaSession = { rutas: [] };

  // Siempre reservar el último slot para "Nueva ruta"
  // Máximo 2 destinos del historial + 1 botón nueva ruta = 3 total
  const MAX_HISTORIAL = 2;

  const ultimoDestino = ultimo
    ? { lat: ultimo.destinoLat, lng: ultimo.destinoLng, nombre: ultimo.destinoNombre }
    : null;
  const ultimoOrigen = ultimo
    ? { lat: ultimo.origenLat, lng: ultimo.origenLng, nombre: ultimo.origenNombre }
    : null;

  if (ultimo && botones.length < MAX_HISTORIAL) {
    const nombreUltimo = acortarParaBoton(ultimoDestino?.nombre || "", 14);
    const titleUltimo = nombreUltimo ? `🔄 ${nombreUltimo}` : "🔄 Último viaje";
    botones.push({ id: "hist_ultimo", title: titleUltimo });
    idsParaSession.ultimo = { origen: ultimoOrigen, destino: ultimoDestino };
  }

  let agregados = 0;
  for (let i = 0; i < frecuentes.length && botones.length < MAX_HISTORIAL; i++) {
    const f = frecuentes[i];
    if (
      ultimoDestino &&
      Math.abs(ultimoDestino.lat - f.destino.lat) < 0.001 &&
      Math.abs(ultimoDestino.lng - f.destino.lng) < 0.001
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
  if (!chofer) return false;
  // Los superchoferes (números de prueba) están EXENTOS del pago diario:
  // siempre se consideran al día para poder recibir viajes sin pagar la cuota.
  if (chofer.phone && CONFIG.CHOFER_PRUEBA_PHONES.includes(chofer.phone)) return true;
  return chofer.pagoDiarioPagado && chofer.pagoDiarioAprobado && chofer.pagoDiarioFechaStr === fechaStrBolivia().split("T")[0];
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

// ─── Similitud de nombres de calles (distancia de edición) ───────────────────
// La transcripción de voz varía ("Apurímac" → "Apurimakk", "Urpi" → "Urpy"):
// el match exacto de llave falla y el geocoding de Google puede mandar el
// punto a kilómetros. Levenshtein tolera esos errores de 1-2 letras; los
// trigramas no sirven aquí porque castigan demasiado los nombres cortos.
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

// Devuelve un score 0..1; se considera "la misma calle" si el score es ≥ 0.75
// (equivale a: 1 error de dicción en nombres cortos, 2 en nombres largos).
function _similitudCalle(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = _levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const tolerancia = maxLen <= 6 ? 1 : 2;
  if (dist > tolerancia) return 0;
  return 1 - dist / maxLen;
}

// Buscar una esquina ya mapeada en la BD
// Retorna: { esquina, requiereConfirmacion } o null si no existe
// IMPORTANTE: se filtra por CIUDAD para no cruzar calles con el mismo nombre
// entre Cochabamba, La Paz y Santa Cruz (ej: "Ballivián y Calle 1").
async function buscarEsquinaMapeada(calle1, calle2, zona = null, ciudad = null) {
  try {
    const { EsquinaMapeada } = require("../db/models");
    const filtroCiudad = ciudad ? { ciudad } : {}; // sin ciudad = comportamiento legacy
    let esquina = null;

    // Si el usuario especificó zona, buscar exacta primero (en su ciudad)
    if (zona) {
      esquina = await EsquinaMapeada.findFirst({ where: { llave: llaveEsquina(calle1, calle2, zona), ...filtroCiudad } });
      if (esquina) return { esquina, requiereConfirmacion: false };
    }

    // Buscar sin zona (todas las que tengan esa combinación en la ciudad)
    const llaveBase = llaveEsquina(calle1, calle2, null);
    const candidatasRaw = await EsquinaMapeada.findMany({
      where: { llave: { startsWith: llaveBase }, ...filtroCiudad },
      orderBy: { usos: "desc" },
      take: 20,
    });
    let candidatas = candidatasRaw
      .filter(c => c.llave === llaveBase || c.llave.startsWith(`${llaveBase}|`))
      .slice(0, 5);

    // FALLBACK DIFUSO: sin match exacto, comparar por similitud de trigramas
    // contra las esquinas más usadas. Cada calle debe parecerse ≥ 0.8 a la
    // guardada (probando ambos órdenes). Caso real: "Urpi y Apurimakk" (audio)
    // no encontraba la esquina guardada "Urpi y Apurimac" y Google geocodificó
    // un punto a 4 km.
    if (candidatas.length === 0) {
      const c1 = normalizarNombreCalle(calle1);
      const c2 = normalizarNombreCalle(calle2);
      if (c1 && c2) {
        const todas = await EsquinaMapeada.findMany({ where: { ...filtroCiudad }, orderBy: { usos: "desc" }, take: 300 });
        const puntuadas = [];
        for (const cand of todas) {
          const e1 = normalizarNombreCalle(cand.calle1);
          const e2 = normalizarNombreCalle(cand.calle2);
          const directo = Math.min(_similitudCalle(c1, e1), _similitudCalle(c2, e2));
          const cruzado = Math.min(_similitudCalle(c1, e2), _similitudCalle(c2, e1));
          const score = Math.max(directo, cruzado);
          if (score >= 0.75) puntuadas.push({ cand, score });
        }
        puntuadas.sort((a, b) => b.score - a.score || (b.cand.usos || 0) - (a.cand.usos || 0));
        if (puntuadas.length > 0) {
          log.info(`[ESQUINA_FUZZY] "${calle1} y ${calle2}" ≈ "${puntuadas[0].cand.calle1} y ${puntuadas[0].cand.calle2}" (score ${puntuadas[0].score.toFixed(2)})`);
          candidatas = puntuadas.slice(0, 5).map(p => p.cand);
        }
      }
    }

    if (candidatas.length === 0) return null;
    
    // PROTECCIÓN 1: Si hay MÚLTIPLES esquinas con mismas calles pero diferente zona
    // (ej: "Ayacucho y Sucre" en Centro Y en Sacaba) — devolver con bandera de confirmación
    if (candidatas.length > 1) {
      return { esquina: candidatas[0], requiereConfirmacion: true, alternativas: candidatas };
    }
    
    // PROTECCIÓN 2: Si la esquina tiene MUY POCOS usos (1-2), pedir confirmación
    // porque puede haber sido mapeada mal por el primer usuario
    const e = candidatas[0];
    if ((e.usos || 0) < 3) {
      return { esquina: e, requiereConfirmacion: true };
    }
    
    // Esquina única y con suficientes usos → confiable
    return { esquina: e, requiereConfirmacion: false };
  } catch (e) { 
    return null; 
  }
}

// Validación silenciosa: comparar coords guardadas contra Google
// Devuelve true si la esquina parece confiable, false si hay discrepancia
async function validarEsquinaConGoogle(esquina, calle1, calle2, ciudad = null) {
  try {
    const { geocodificarConMemoria } = require("./google");
    // La ciudad la agrega geocodificarConMemoria vía contextoGeocode; no hardcodear.
    const consulta = `${calle1} y ${calle2}`;
    const resGoogle = await geocodificarConMemoria(consulta, ciudad || esquina.ciudad || null);
    if (!resGoogle || !resGoogle.lat) return true; // si Google falla, confiar en lo guardado
    
    // Calcular distancia entre coords guardadas y Google
    const dx = (esquina.lat - resGoogle.lat) * 111;
    const dy = (esquina.lng - resGoogle.lng) * 111 * Math.cos(esquina.lat * Math.PI / 180);
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Si están a menos de 2 km, son la misma esquina (margen de error normal)
    return dist < 2;
  } catch (e) {
    return true; // en error, confiar
  }
}

// Guardar una esquina nueva en memoria compartida
async function guardarEsquina(calle1, calle2, lat, lng, opciones = {}) {
  try {
    const { EsquinaMapeada } = require("../db/models");
    const llave = llaveEsquina(calle1, calle2, opciones.zona);
    if (!llave) return null;
    // La MISMA llave puede existir en varias ciudades (calles con igual nombre):
    // la identidad real es (llave, ciudad).
    const ciudad = opciones.ciudad || CONFIG.CIUDAD_DEFAULT;

    const existente = await EsquinaMapeada.findFirst({ where: { llave, ciudad } });
    if (existente) {
      // Ya existe en esta ciudad — solo aumentar contador
      return await EsquinaMapeada.update({
        where: { id: existente.id },
        data: { usos: (existente.usos || 0) + 1, ultimoUso: new Date() },
      });
    }

    return await EsquinaMapeada.create({
      data: {
        llave,
        calle1: calle1.trim(),
        calle2: calle2.trim(),
        zona: opciones.zona || null,
        ciudad,
        lat, lng,
        usos: 1,
        primerUsuario: opciones.phone || null,
        ultimoUso: new Date(),
      },
    });
  } catch (e) { return null; }
}

// Obtener el lugar personal del usuario (casa/trabajo)
async function obtenerLugarPersonal(phone, tipo) {
  try {
    const { Usuario } = require("../db/models");
    const u = await Usuario.findUnique({ where: { phone } });
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
    const u = await Usuario.findUnique({ where: { phone } });
    if (!u) return false;
    const lugaresFrecuentes = { ...(u.lugaresFrecuentes || {}), [tipo]: { lat, lng, nombre } };
    await Usuario.update({ where: { phone }, data: { lugaresFrecuentes } });
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
    
    // Lugares grandes (UMSS, Estadio, etc.) → vagos, pedir referencia/pin
    // Incluye siglas Y nombres completos (la transcripción de voz suele dar el nombre largo)
    const lugaresGrandes = [
      "umss", "universidad mayor de san simon", "san simon",
      "ucb", "universidad catolica", "upb", "universidad privada",
      "univalle", "universidad del valle", "unifranz", "uatf",
      "estadio", "capriles", "felix capriles",
      "mercado", "cancha", "plaza colon", "plaza recoleta",
      "facultad", "campus", "ciudad universitaria",
    ];
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
// Tarifas ChatGo Cochabamba 2026 (escalonadas):
// AUTO:  <4km→Bs3.5/km | 4-10km→Bs2.5/km | >10km→Bs2.0/km | mínimo Bs6
// MOTO:  <4km→Bs2.5/km | 4-10km→Bs2.0/km | >10km→Bs1.5/km | mínimo Bs5
// NOCTURNO: 23:00-06:00 → +15%
function calcularPrecio(km, tipoVehiculo, recargoSubida = 0) {
  // Tarifa escalonada según distancia
  const tarifas = {
    auto: [
      { hasta: 4,        porKm: 3.5, minimo: 6 },
      { hasta: 10,       porKm: 2.5, minimo: 6 },
      { hasta: Infinity, porKm: 2.0, minimo: 6 },
    ],
    moto: [
      { hasta: 4,        porKm: 2.5, minimo: 5 },
      { hasta: 10,       porKm: 2.0, minimo: 5 },
      { hasta: Infinity, porKm: 1.5, minimo: 5 },
    ],
    // VAN (8 a 14 pasajeros). Tarifa de ARRANQUE — ajustar cuando la Federación pase su lista.
    van: [
      { hasta: 4,        porKm: 5.0, minimo: 15 },
      { hasta: 10,       porKm: 4.5, minimo: 15 },
      { hasta: Infinity, porKm: 4.0, minimo: 15 },
    ],
  };

  const escalones = tarifas[tipoVehiculo] || tarifas.auto;
  const escalon = escalones.find(e => km <= e.hasta);
  const minimo = escalon.minimo;
  const precioPorKm = escalon.porKm;

  let calculado = km * precioPorKm;

  // Tarifa nocturna: 23:00 a 06:00 → +15%
  const horaBolivia = new Date(Date.now() + CONFIG.OFFSET_HORAS * 60 * 60 * 1000).getUTCHours();
  const esNocturno = horaBolivia >= 23 || horaBolivia < 6;
  if (esNocturno) calculado = calculado * 1.15;
  const base = Math.max(Math.round(calculado), minimo);
  // Recargo por subida (topografía): se suma al final, no se le aplica nocturno.
  const recargo = Math.max(0, Math.round(recargoSubida || 0));
  const total = base + recargo;
  return {
    total,
    precioPorKm,
    esNocturno,
    recargoSubida: recargo,
  };
}


// ─── LUGARES PERSONALIZADOS (otros[]) ────────────────────────────────────────

const _sinAcentos = s => String(s).toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Busca un alias en lugaresFrecuentes.otros[] (case-insensitive, sin acentos).
async function obtenerLugarOtros(phone, alias) {
  try {
    const { Usuario } = require("../db/models");
    const u = await Usuario.findUnique({ where: { phone } });
    if (!u || !u.lugaresFrecuentes?.otros?.length) return null;
    const norm = _sinAcentos(alias);
    return u.lugaresFrecuentes.otros.find(o => _sinAcentos(o.alias) === norm) || null;
  } catch (e) { return null; }
}

// Guarda (o actualiza) un lugar en lugaresFrecuentes.otros[].
async function guardarLugarOtros(phone, alias, lat, lng, nombre) {
  try {
    const { Usuario } = require("../db/models");
    const u = await Usuario.findUnique({ where: { phone } });
    if (!u) return false;
    const lf = u.lugaresFrecuentes || {};
    const otros = lf.otros || [];
    const norm = String(alias).toLowerCase().trim();
    const idx = otros.findIndex(o => o.alias?.toLowerCase().trim() === norm);
    const entrada = { alias: norm, lat, lng, nombre };
    if (idx >= 0) otros[idx] = entrada; else otros.push(entrada);
    await Usuario.update({ where: { phone }, data: { lugaresFrecuentes: { ...lf, otros } } });
    return true;
  } catch (e) { return false; }
}

// Elimina un alias de lugaresFrecuentes.otros[].
async function eliminarLugarOtros(phone, alias) {
  try {
    const { Usuario } = require("../db/models");
    const u = await Usuario.findUnique({ where: { phone } });
    if (!u || !u.lugaresFrecuentes?.otros) return false;
    const lf = u.lugaresFrecuentes;
    const norm = String(alias).toLowerCase().trim();
    const otros = lf.otros.filter(o => o.alias?.toLowerCase().trim() !== norm);
    await Usuario.update({ where: { phone }, data: { lugaresFrecuentes: { ...lf, otros } } });
    return true;
  } catch (e) { return false; }
}

module.exports = { fechaStrBolivia, horaStrBolivia, formatearFechaPromo, promoCodigosActiva, enPromoGratis, choferPagoAlDia, generarCodigoUnico, crearCodigoPromo, validarCodigoPromo, consumirCodigoPromo, mensajeCodigoEntregado, enviarCodigoDescuento, validarPlaca, normalizarPlaca, acortarParaBoton, esIntentoCancelar, esPedidoAyuda, esPlusCode, detectarIncompatibilidadMoto, obtenerUltimoViaje, obtenerDestinosFrecuentes, guardarRutaFrecuente, sugerenciaPorHora, construirBotonesHistorial, escapeHtml, normalizarNombreCalle, llaveEsquina, buscarEsquinaMapeada, guardarEsquina, obtenerLugarPersonal, guardarLugarPersonal, obtenerLugarOtros, guardarLugarOtros, eliminarLugarOtros, evaluarReferencia, mensajePidiendoReferencia, calcularPrecio, validarEsquinaConGoogle };
