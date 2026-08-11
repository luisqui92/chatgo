// ChatGo — Google Maps y memoria de voz
const axios = require("axios");
const https = require("https");
const http = require("http");
const url = require("url");
const os = require("os");
const { CONFIG, log } = require("../config");
const { LocationReference } = require("../db/models");
const { getContextoGeocode, getBoundsUsuario } = require("../config");
const { esPlusCode } = require("../services/utils");


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

function evaluarPrecisionReferencia(referencia) {
  if (!referencia) return { precisa: false, motivo: "vacía" };
  const ref = referencia.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  // Indicadores de ALTA precisión
  const tieneInterseccion = /(esquina|esq|con|y|casi|entre|frente a|frente al|al lado|diagonal)/.test(ref);
  const tieneNumero = /\d{2,}/.test(ref); // número de calle o referencia numérica
  const tieneReferencia = /(entrada|salida|puerta|portón|parada|semaforo|rotonda|redondel|bajando|subiendo|antes|despues|pasando)/.test(ref);

  // Lugares que son inherentemente imprecisos (grandes extensiones)
  const lugaresGrandes = [
    "cancha","mercado","feria","stadium","estadio","aeropuerto","terminal","universidad","umss","upb","ucb",
    "hospital","clinica","plaza","parque","coliseo","cinecentro","hipermaxi","shopping","mall","zona","barrio"
  ];
  const esLugarGrande = lugaresGrandes.some(l => ref.includes(l));

  if (esLugarGrande && !tieneInterseccion && !tieneNumero && !tieneReferencia) {
    return {
      precisa: false,
      motivo: "lugar_grande",
      sugerencia: `Podés decir por ejemplo: _"${referencia}, esquina [calle] y [calle]"_ o la entrada más cercana`
    };
  }

  if (tieneInterseccion || tieneNumero || tieneReferencia) {
    return { precisa: true };
  }

  // Referencia corta sin ningún indicador
  if (ref.split(" ").length <= 2) {
    return {
      precisa: false,
      motivo: "muy_generico",
      sugerencia: `Intentá dar una referencia más exacta, como una esquina o punto de referencia cercano`
    };
  }

  return { precisa: true };
}

// ─── FEATURE: Parsear URLs de Google Maps ──────────────────────────────────
// Extrae coordenadas de links compartidos de Google Maps:
// - https://www.google.com/maps/@-17.39,-66.15,15z
// - https://www.google.com/maps/place/.../@-17.39,-66.15,...
// - https://maps.google.com/maps?q=-17.39,-66.15
// - https://maps.app.goo.gl/... (URL corta, requiere resolver redirect)

function extraerCoordsDeUrlGmaps(texto) {
  if (!texto) return null;

  // Patrón 1: @lat,lng en la URL
  const atMatch = texto.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 2: ?q=lat,lng o &q=lat,lng
  const qMatch = texto.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 3: /maps/place/.../lat,lng (último par de números flotantes)
  const placeMatch = texto.match(/maps\/place\/[^@]*@?(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (placeMatch) {
    const lat = parseFloat(placeMatch[1]);
    const lng = parseFloat(placeMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  // Patrón 4: ll=lat,lng (URL clásica de Google Maps)
  const llMatch = texto.match(/ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (llMatch) {
    const lat = parseFloat(llMatch[1]);
    const lng = parseFloat(llMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }

  return null;
}

// Resuelve una URL corta (maps.app.goo.gl) siguiendo redirects

async function resolverUrlCorta(url) {
  // Sigue redirects manualmente leyendo el header Location en cada paso.
  // axios con maxRedirects:0 + validateStatus:true NO lanza error en 3xx,
  // simplemente devuelve la respuesta con el status 3xx y el header Location.
  let currentUrl = url;
  // Presupuesto total de tiempo para no colgar la respuesta del bot: en la
  // práctica un maps.app.goo.gl resuelve en 1-2 saltos. Antes: 8×6s=48s peor caso.
  const deadline = Date.now() + 8000;
  try {
    for (let i = 0; i < 5; i++) {
      if (Date.now() > deadline) { log.warn("[GMAPS_REDIRECT] Presupuesto de tiempo agotado"); return currentUrl; }
      const res = await axios.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 3500,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers?.location) {
        const loc = res.headers.location;
        // location puede ser relativa o absoluta
        currentUrl = loc.startsWith("http") ? loc : new URL(loc, currentUrl).href;
        log.debug(`[GMAPS_REDIRECT] ${res.status} → ${currentUrl.slice(0, 80)}`);
      } else {
        // Llegamos a la URL final (200 u otro no-redirect)
        return currentUrl;
      }
    }
    return currentUrl;
  } catch (e) {
    // Si axios lanza por timeout u otro motivo, devolver lo que teníamos
    log.warn(`[GMAPS_REDIRECT] Error resolviendo URL: ${e.message}`);
    return currentUrl;
  }
}

// Intenta extraer nombre del lugar de una URL de Google Maps para geocodificar como fallback

function extraerNombreLugarDeUrl(url) {
  try {
    // /maps/place/Nombre+Del+Lugar/...
    const placeMatch = url.match(/maps\/place\/([^/@?]+)/);
    if (placeMatch) {
      const nombre = decodeURIComponent(placeMatch[1].replace(/\+/g, " ")).trim();
      // Ignorar si parece un código o está vacío
      if (nombre.length > 3 && !/^[\d,.-]+$/.test(nombre)) return nombre;
    }
  } catch {}
  return null;
}

// Detecta si un texto contiene un link de Google Maps y extrae coords

async function detectarYExtrarCoordsMaps(texto, ciudadUsuario = CONFIG.CIUDAD_DEFAULT) {
  if (!texto) return null;

  // URL corta de Google Maps (maps.app.goo.gl)
  const urlCortaMatch = texto.match(/https?:\/\/maps\.app\.goo\.gl\/\S+/);
  if (urlCortaMatch) {
    try {
      log.info(`[GMAPS] Resolviendo URL corta: ${urlCortaMatch[0]}`);
      const urlFinal = await resolverUrlCorta(urlCortaMatch[0]);
      log.info(`[GMAPS] URL final: ${urlFinal.slice(0, 120)}`);

      // Intentar extraer coords directamente del URL final
      const coords = extraerCoordsDeUrlGmaps(urlFinal);
      if (coords) {
        log.info(`[GMAPS] Coords extraídas del URL: (${coords.lat}, ${coords.lng})`);
        return coords;
      }

      // Fallback: extraer nombre del lugar y geocodificar
      const nombreLugar = extraerNombreLugarDeUrl(urlFinal);
      if (nombreLugar) {
        log.info(`[GMAPS] Fallback geocode por nombre: "${nombreLugar}"`);
        const geocoded = await geocodificarConMemoria(nombreLugar, ciudadUsuario);
        if (geocoded) return geocoded;
      }
    } catch (e) {
      log.error("[GMAPS]", e.message);
    }
  }

  // URL larga de Google Maps directamente en el texto
  if (texto.includes("google.com/maps") || texto.includes("maps.google.com")) {
    const coords = extraerCoordsDeUrlGmaps(texto);
    if (coords) return coords;

    // Fallback: extraer nombre del lugar del URL largo
    const nombreLugar = extraerNombreLugarDeUrl(texto);
    if (nombreLugar) {
      log.info(`[GMAPS] Fallback geocode URL largo: "${nombreLugar}"`);
      return await geocodificarConMemoria(nombreLugar, ciudadUsuario);
    }
  }

  return null;
}

// ─── FEATURE: Memoria de referencias de voz ────────────────────────────────

function normalizarReferencia(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(al|el|la|los|las|un|una|de|del|en|por|y|o|a|por favor|porfavor)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Genera trigramas de un texto para búsqueda difusa

function generarTrigramas(texto) {
  const t = " " + texto + " ";
  const trigramas = new Set();
  for (let i = 0; i < t.length - 2; i++) {
    trigramas.add(t.slice(i, i + 3));
  }
  return [...trigramas];
}

// Similitud de Jaccard entre dos textos usando trigramas

function similitudTexto(a, b) {
  const tA = new Set(generarTrigramas(a));
  const tB = new Set(generarTrigramas(b));
  const interseccion = [...tA].filter(t => tB.has(t)).length;
  const union = new Set([...tA, ...tB]).size;
  return union === 0 ? 0 : interseccion / union;
}

// Extrae nombres de calles, quitando palabras genéricas (calle, esquina, avenida, etc.)
function extraerCallesDeReferencia(textoNorm) {
  const genericas = new Set(["calle","avenida","av","avda","esquina","esq","plaza","plazuela","pasaje","pje","camino","carretera","ruta","entre","con","final","zona","barrio","frente","cerca","lado","altura","numero","nro","casi"]);
  return textoNorm.split(" ").filter(p => p.length >= 3 && !genericas.has(p));
}

// Determina si dos referencias son el MISMO lugar.
// Para intersecciones (2 calles): una calle debe coincidir fuerte (>=80%) y la otra
// al menos parcial (>=50%). Esto reconoce el mismo cruce aunque el usuario hable mal
// (ej: "Apurimac" dicho como "Purimac"), pero NO confunde cruces distintos
// (ej: "Urpi y Apurimac" vs "Apurimac y Tarata" → NO match, porque la 2da calle difiere).
function esMismaUbicacion(textoNormA, textoNormB) {
  if (textoNormA === textoNormB) return true;
  const callesA = extraerCallesDeReferencia(textoNormA);
  const callesB = extraerCallesDeReferencia(textoNormB);
  if (callesA.length === 0 || callesB.length === 0) return false;

  // Caso intersección: ambas tienen 2+ calles
  if (callesA.length >= 2 && callesB.length >= 2) {
    const sims = callesA.map(ca => Math.max(...callesB.map(cb => similitudTexto(ca, cb))));
    sims.sort((a, b) => b - a);
    const c1 = sims[0] || 0;
    const c2 = sims[1] || 0;
    return c1 >= 0.8 && c2 >= 0.5;
  }

  // Caso lugar simple (1 calle/nombre): debe coincidir fuerte
  const setB = new Set(callesB);
  const comunes = callesA.filter(p => setB.has(p) || callesB.some(pb => similitudTexto(p, pb) >= 0.7));
  return comunes.length / Math.max(callesA.length, callesB.length) >= 0.99;
}

async function buscarReferenciaEnMemoria(referencia, ciudadUsuario) {
  if (!referencia || referencia.length < 4) return null;
  if (!ciudadUsuario) {
    log.warn(`[VOICE_MEM] buscarReferenciaEnMemoria llamado sin ciudad para "${referencia}" — usando Cochabamba por defecto. Revisar call site.`);
    ciudadUsuario = CONFIG.CIUDAD_DEFAULT;
  }
  const norm = normalizarReferencia(referencia);

  // 1. Búsqueda exacta filtrada por ciudad (SOLO esa ciudad, sin fallback a otras
  // para no agarrar un lugar homónimo de otra ciudad, ej Ventura Mall que existe
  // tanto en Santa Cruz como en datos viejos de Cochabamba)
  const docExacto = await LocationReference.findUnique({
    where: { referencia_ciudad: { referencia: norm, ciudad: ciudadUsuario } },
  });
  if (docExacto) {
    log.info(`[VOICE_MEM] Hit exacto: "${referencia}" en ${ciudadUsuario} → (${docExacto.lat}, ${docExacto.lng})`);
    await LocationReference.update({ where: { id: docExacto.id }, data: { contador: { increment: 1 } } });
    return { lat: docExacto.lat, lng: docExacto.lng, nombre: docExacto.nombreResuelto };
  }

  // 2. Búsqueda difusa — comparar similitud con referencias DE LA MISMA CIUDAD
  // Solo si la referencia tiene más de 6 caracteres (evitar falsos positivos)
  if (norm.length < 6) return null;

  // Filtrar por ciudad para no confundir lugares de distintas ciudades
  // (ej: una "avenida 6 de Agosto" existe en varias ciudades)
  const todas = await LocationReference.findMany({ where: { ciudad: ciudadUsuario } });

  // NUEVO: match por intersección/palabras clave en vez de similitud global estricta.
  // Reconoce el mismo lugar aunque el usuario diga las calles distinto, sin confundir
  // cruces diferentes (ver esMismaUbicacion).
  let mejorMatch = null;
  for (const doc of todas) {
    if (esMismaUbicacion(norm, doc.referencia)) {
      mejorMatch = doc;
      break;
    }
  }

  if (mejorMatch) {
    log.info(`[VOICE_MEM] Hit por calles: "${referencia}" ~ "${mejorMatch.referenciaOriginal}" → (${mejorMatch.lat}, ${mejorMatch.lng})`);
    // Guardar la variante nueva en la MISMA ciudad (no en el default)
    await guardarReferenciaVoz(referencia, mejorMatch.lat, mejorMatch.lng, mejorMatch.nombreResuelto, ciudadUsuario);
    return { lat: mejorMatch.lat, lng: mejorMatch.lng, nombre: mejorMatch.nombreResuelto };
  }

  return null;
}

async function guardarReferenciaVoz(referenciaOriginal, lat, lng, nombre, ciudadUsuario) {
  if (!referenciaOriginal || referenciaOriginal.length < 4) return;
  if (!ciudadUsuario) {
    log.warn(`[VOICE_MEM] guardarReferenciaVoz llamado sin ciudad para "${referenciaOriginal}" — usando Cochabamba por defecto. Revisar call site.`);
    ciudadUsuario = CONFIG.CIUDAD_DEFAULT;
  }
  try {
    const norm = normalizarReferencia(referenciaOriginal);
    await LocationReference.upsert({
      where: { referencia_ciudad: { referencia: norm, ciudad: ciudadUsuario } },
      create: { referencia: norm, referenciaOriginal, lat, lng, nombreResuelto: nombre, ciudad: ciudadUsuario, contador: 1 },
      update: { referenciaOriginal, lat, lng, nombreResuelto: nombre, ciudad: ciudadUsuario, contador: { increment: 1 } },
    });
    log.info(`[VOICE_MEM] Guardado: "${referenciaOriginal}" (${ciudadUsuario}) → ${nombre}`);
  } catch (e) {
    log.error("[VOICE_MEM] Error guardando:", e.message);
  }
}

// Bounding box de Cochabamba (ciudad + área metropolitana)
const CBBA_BOUNDS = { latMin: -17.55, latMax: -17.20, lngMin: -66.35, lngMax: -66.05 };

function dentroDeCocha(lat, lng) {
  return lat >= CBBA_BOUNDS.latMin && lat <= CBBA_BOUNDS.latMax &&
         lng >= CBBA_BOUNDS.lngMin && lng <= CBBA_BOUNDS.lngMax;
}

// Wrapper: busca en memoria primero, si no geocodifica con validación geográfica

function dentroDeZonaCiudad(lat, lng, ciudadUsuario) {
  const boundsU = getBoundsUsuario(ciudadUsuario);
  return lat >= boundsU.latMin && lat <= boundsU.latMax &&
    lng >= boundsU.lngMin && lng <= boundsU.lngMax;
}

async function geocodificarConMemoria(referencia, ciudadUsuario) {
  if (!referencia) return null;
  if (!ciudadUsuario) {
    log.warn(`[VOICE_MEM] geocodificarConMemoria llamado sin ciudad para "${referencia}" — usando Cochabamba por defecto. Revisar call site.`);
    ciudadUsuario = CONFIG.CIUDAD_DEFAULT;
  }

  // 1. Buscar en memoria local filtrada por ciudad
  const enMemoria = await buscarReferenciaEnMemoria(referencia, ciudadUsuario);
  if (enMemoria) {
    // Validar bounds también en hits de memoria: una referencia vieja sin ciudad
    // o un match difuso entre ciudades no debe devolver coords fuera de zona.
    if (!dentroDeZonaCiudad(enMemoria.lat, enMemoria.lng, ciudadUsuario)) {
      log.warn(`[VOICE_MEM] "${referencia}" → hit en memoria fuera de ${ciudadUsuario} — descartado`);
    } else {
      log.info(`[VOICE_MEM] Cache hit: "${referencia}" (${ciudadUsuario})`);
      return enMemoria;
    }
  }

  // 2. Geocodificar con Google Maps usando contexto de ciudad
  const coords = await geocodificarDireccion(referencia, true, ciudadUsuario);
  if (!coords) return null;

  // 3. Validar que el resultado esté dentro de la ciudad del usuario
  if (!dentroDeZonaCiudad(coords.lat, coords.lng, ciudadUsuario)) {
    log.warn(`[GEOCOD] "${referencia}" → fuera de ${ciudadUsuario} — descartado`);
    return null;
  }

  // 4. Validar confianza del resultado
  const tipos = coords._tipos || [];

  // Tipos confiables: intersecciones, calles con número, plus codes
  const esConfiable =
    tipos.includes("intersection") ||
    tipos.includes("street_address") ||
    tipos.includes("premise") ||
    tipos.includes("subpremise");

  // Tipos aceptables: puntos de interés conocidos, establecimientos nombrados
  const esAceptable =
    tipos.includes("point_of_interest") ||
    tipos.includes("establishment") ||
    tipos.includes("transit_station") ||
    tipos.includes("airport") ||
    tipos.includes("university") ||
    tipos.includes("hospital") ||
    tipos.includes("park");

  // Tipos sospechosos: establecimientos comerciales genéricos sin que el usuario los nombrara
  const esSospechoso =
    !esConfiable &&
    tipos.some(t => ["hair_care","health","food","store","lodging","finance","car_repair"].includes(t));

  if (esSospechoso) {
    log.warn(`[GEOCOD] "${referencia}" → resultado sospechoso (${tipos.join(",")}) — descartado`);
    return null;
  }

  // Resultado a nivel CIUDAD/PROVINCIA: inservible como punto de viaje.
  // Caso real: destino "Encañada y Ejército" geocodificó al centro genérico de
  // "Cochabamba" (locality) y se cotizó un viaje de 11.8 km a ninguna parte.
  const esNivelCiudad =
    !esConfiable && !esAceptable &&
    tipos.some(t => ["locality","administrative_area_level_1","administrative_area_level_2","administrative_area_level_3","country"].includes(t));
  if (esNivelCiudad) {
    log.warn(`[GEOCOD] "${referencia}" → resultado a nivel ciudad (${tipos.join(",")}) — descartado`);
    return null;
  }

  // Resultado a nivel BARRIO/ZONA: demasiado impreciso para recoger a alguien
  const esBarrio =
    !esConfiable && !esAceptable &&
    tipos.some(t => ["neighborhood","sublocality","sublocality_level_1","sublocality_level_2"].includes(t));
  if (esBarrio) {
    log.warn(`[GEOCOD] "${referencia}" → resultado a nivel barrio (${tipos.join(",")}) — requiere confirmación`);
    return { ...coords, _incierto: true };
  }

  // Ruta genérica sin intersección
  const esRutaGenerica = tipos.includes("route") && !tipos.includes("intersection") && !esConfiable;
  if (esRutaGenerica) {
    log.warn(`[GEOCOD] "${referencia}" → ruta genérica (${tipos.join(",")}) — requiere confirmación`);
    return { ...coords, _incierto: true };
  }

  // 5. Guardar en memoria para futuros usos (en la ciudad del usuario)
  await guardarReferenciaVoz(referencia, coords.lat, coords.lng, coords.nombre, ciudadUsuario);
  return coords;
}

// Distancia real por calles vía Routes API (la Distance Matrix legacy está
// bloqueada en proyectos nuevos de Google Cloud — daba fallback Haversine siempre)
async function calcularDistancia(origen, destino) {
  try {
    const rutas = await calcularRutasConTrafico(origen, destino);
    if (!rutas.length) throw new Error("fallback");
    const r = rutas[0];
    return {
      km: Math.round((r.distanciaM / 1000) * 10) / 10,
      duracion: `${Math.round(r.duracionSeg / 60)} min`,
      esAproximado: false,
    };
  } catch {
    const km = Math.round(distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng) * 1.3 * 10) / 10;
    return { km, duracion: `~${Math.round(km * 3)} min`, esAproximado: true };
  }
}

// ─── RECARGO POR SUBIDA (topografía de La Paz) ──────────────────────────────
// Mide el desnivel del viaje con la API de Elevación de Google y devuelve el
// recargo en Bs si el destino está MÁS ALTO que el origen (subida). En bajada o
// plano devuelve 0. Nunca lanza: ante cualquier fallo devuelve recargo 0.
async function obtenerRecargoSubida(origen, destino) {
  const cero = { recargoBs: 0, desnivelM: 0 };
  try {
    if (!CONFIG.RECARGO_SUBIDA_ENABLED) return cero;
    if (!origen?.lat || !destino?.lat || !CONFIG.GOOGLE_MAPS_KEY) return cero;
    const res = await axios.get("https://maps.googleapis.com/maps/api/elevation/json", {
      params: { locations: `${origen.lat},${origen.lng}|${destino.lat},${destino.lng}`, key: CONFIG.GOOGLE_MAPS_KEY },
      timeout: 4000,
    });
    const r = res.data?.results;
    if (!Array.isArray(r) || r.length < 2) return cero;
    const desnivelM = Math.round(r[1].elevation - r[0].elevation); // + = subida
    if (desnivelM <= CONFIG.RECARGO_SUBIDA_UMBRAL_M) return { recargoBs: 0, desnivelM };
    const bruto = (desnivelM / 100) * CONFIG.RECARGO_SUBIDA_BS_POR_100M;
    const recargoBs = Math.min(Math.round(bruto), CONFIG.RECARGO_SUBIDA_MAX_BS);
    log.info(`[SUBIDA] Desnivel ${desnivelM} m → recargo Bs ${recargoBs}`);
    return { recargoBs, desnivelM };
  } catch (e) {
    log.warn(`[SUBIDA] No se pudo medir elevación: ${e.message}`);
    return cero;
  }
}

// Calcula tiempo en ruta con tráfico en tiempo real
// ─── COPILOTO IA: ruta completa con polilínea (Directions API) ──────────────
// Decodifica el formato polyline de Google a array de {lat,lng}
function decodificarPolyline(encoded) {
  const puntos = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
    puntos.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return puntos;
}

// Obtiene la ruta recomendada: polilínea, distancia, tiempo. Para guardar al aceptar el viaje.
async function obtenerRutaCompleta(origenLat, origenLng, destinoLat, destinoLng) {
  try {
    const rutas = await calcularRutasConTrafico(
      { lat: origenLat, lng: origenLng },
      { lat: destinoLat, lng: destinoLng }
    );
    if (!rutas.length) return null;
    const r = rutas[0];
    return {
      polilinea: r.polilineaCodificada,
      puntos: r.puntos,
      distanciaKm: Math.round(r.distanciaM / 100) / 10,
      minutosEstimados: Math.round(r.duracionSeg / 60),
    };
  } catch (e) {
    log.error("[RUTA_COMPLETA]", e.response?.data?.error?.message || e.message);
    return null;
  }
}

// Distancia mínima (metros) de un punto a la polilínea de la ruta. Para detectar desvío.
function distanciaARuta(lat, lng, puntosRuta) {
  if (!puntosRuta || puntosRuta.length === 0) return null;
  let minMetros = Infinity;
  for (const p of puntosRuta) {
    const d = distanciaEntrePuntos(lat, lng, p.lat, p.lng) * 1000; // km → m
    if (d < minMetros) minMetros = d;
  }
  return Math.round(minMetros);
}

async function calcularTiempoConTrafico(origenLat, origenLng, destinoLat, destinoLng) {
  try {
    const rutas = await calcularRutasConTrafico(
      { lat: origenLat, lng: origenLng },
      { lat: destinoLat, lng: destinoLng }
    );
    if (!rutas.length) return null;
    const r = rutas[0];
    const factorTrafico = r.duracionSinTraficoSeg > 0 ? r.duracionSeg / r.duracionSinTraficoSeg : 1;

    return {
      minutosSinTrafico: Math.round(r.duracionSinTraficoSeg / 60),
      minutosConTrafico: Math.round(r.duracionSeg / 60),
      factorTrafico: Math.round(factorTrafico * 100) / 100,
      hayTrafico: factorTrafico > 1.3, // más de 30% de demora = tráfico significativo
      distanciaKm: Math.round(r.distanciaM / 100) / 10,
    };
  } catch (e) {
    log.error("[TRAFICO]", e.response?.data?.error?.message || e.message);
    return null;
  }
}

async function calcularDistanciaConParadas(origen, paradas, destino) {
  // Una sola llamada a Routes API con las paradas como intermedias
  try {
    const rutas = await calcularRutasConTrafico(origen, destino, paradas || []);
    if (!rutas.length) throw new Error("fallback");
    const r = rutas[0];
    return {
      km: Math.round((r.distanciaM / 1000) * 10) / 10,
      duracion: `${Math.round(r.duracionSeg / 60)} min`,
      esAproximado: false,
    };
  } catch {
    // Respaldo local: Haversine por tramo × 1.3
    const puntos = [origen, ...(paradas || []), destino];
    let kmTotal = 0, minTotal = 0;
    for (let i = 0; i < puntos.length - 1; i++) {
      const km = distanciaEntrePuntos(puntos[i].lat, puntos[i].lng, puntos[i + 1].lat, puntos[i + 1].lng);
      kmTotal += km * 1.3;
      minTotal += km * 3;
    }
    return {
      km: Math.round(kmTotal * 10) / 10,
      duracion: `${Math.round(minTotal)} min`,
      esAproximado: true,
    };
  }
}

function generarLinkMapaPropio(viajeId) {
  const base = CONFIG.APP_URL || "https://api.chatgo.ia.bo";
  return `${base}/mapa/${viajeId}`;
}

function generarLinkRutaConParadas(origen, paradas, destino) {
  let url = `https://www.google.com/maps/dir/?api=1`;
  url += `&origin=${origen.lat},${origen.lng}`;
  url += `&destination=${destino.lat},${destino.lng}`;
  if (paradas && paradas.length > 0) {
    url += `&waypoints=${encodeURIComponent(paradas.map(p => `${p.lat},${p.lng}`).join("|"))}`;
  }
  url += `&travelmode=driving`;
  return url;
}

async function geocodificarDireccion(direccion, reintentoInterseccion = true, ciudadUsuario = CONFIG.CIUDAD_DEFAULT) {
  try {
    const contexto = getContextoGeocode(ciudadUsuario);
    const boundsC = getBoundsUsuario(ciudadUsuario);
    const boundsStr = `${boundsC.latMin},${boundsC.lngMin}|${boundsC.latMax},${boundsC.lngMax}`;
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: `${direccion}, ${contexto}`,
        key: CONFIG.GOOGLE_MAPS_KEY,
        bounds: boundsStr,
        region: "BO",
        language: "es",
      },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    });
    if (!res.data.results?.length) {
      log.warn(`[GEOCOD] Sin resultados para: "${direccion}"`);
      return null;
    }
    // Si la búsqueda es un lugar con nombre (Plaza, Mercado, Parque, etc.),
    // NO agarrar ciegamente el primer resultado: Google a veces pone la CALLE
    // del mismo nombre primero (ej: "Plaza Bolívar" devuelve la calle Bolívar).
    // Elegimos el resultado que sea un lugar real y no una simple ruta/calle.
    const esLugarConNombre = /^\s*(plaza|plazuela|mercado|parque|hospital|mall|cine|estadio|coliseo|terminal|universidad|colegio|iglesia|catedral|aeropuerto|cementerio)\b/i.test(direccion);
    let result = res.data.results[0];
    if (esLugarConNombre && res.data.results.length > 1) {
      // Buscar el primer resultado que NO sea solo una calle (route)
      const noCalle = res.data.results.find(r => {
        const t = r.types || [];
        return !t.includes("route") || t.includes("establishment") || t.includes("park") || t.includes("point_of_interest");
      });
      if (noCalle) {
        result = noCalle;
        log.info(`[GEOCOD] Lugar con nombre "${direccion}": se eligió resultado tipo [${(noCalle.types||[]).join(",")}] en vez de la calle`);
      }
    }
    const loc = result.geometry.location;
    const tipos = result.types || [];
    log.info(`[GEOCOD] "${direccion}" → (${loc.lat}, ${loc.lng}) | "${result.formatted_address}" | tipos: ${tipos.join(",")}`);

    // Si Google devolvió una ruta/avenida genérica (no la intersección exacta)
    // y el texto tiene "esquina", intentar reformatear para mejor precisión
    const esRutaGenerica = tipos.includes("route") && !tipos.includes("intersection");
    const tieneEsquina = /esquina|esq\.|con |y /i.test(direccion);

    if (esRutaGenerica && tieneEsquina && reintentoInterseccion) {
      // Reformatear: "Av. América esquina Chiriguana" → "Av. América & Chiriguana"
      const reformateado = direccion
        .replace(/\s+esquina\s+/i, " & ")
        .replace(/\s+esq\.\s+/i, " & ")
        .replace(/,\s*con\s+/i, " & ");
      log.info(`[GEOCOD] Reintentando intersección: "${reformateado}" (ciudad: ${ciudadUsuario})`);
      const reintento = await geocodificarDireccion(reformateado, false, ciudadUsuario);
      if (reintento) {
        const tiposR = reintento._tipos || [];
        // Preferir resultado de intersección sobre ruta
        if (!tiposR.includes("route") || tiposR.includes("intersection")) {
          return reintento;
        }
      }
    }

    return { lat: loc.lat, lng: loc.lng, nombre: result.formatted_address, _tipos: tipos };
  } catch (e) {
    log.error(`[GEOCOD] Error para "${direccion}":`, e.message);
    return null;
  }
}

// FIX BUG#12 — obtenerDireccion evita devolver Plus Codes como nombre

async function obtenerDireccion(lat, lng) {
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, key: CONFIG.GOOGLE_MAPS_KEY, language: "es" },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    });
    if (!res.data.results?.length) return null;

    const result = res.data.results[0];
    const comps = result.address_components;

    const calle = comps.find(c => c.types.includes("route"))?.long_name || "";
    const numero = comps.find(c => c.types.includes("street_number"))?.long_name || "";
    const barrio = comps.find(c => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name || "";

    let nombre = null;
    if (calle && !esPlusCode(calle)) {
      nombre = numero ? `${calle} ${numero}` : barrio ? `${calle}, ${barrio}` : calle;
    }

    // Si no tenemos nombre legible o es un Plus Code, usar formatted_address limpio
    if (!nombre || esPlusCode(nombre)) {
      const formatted = result.formatted_address;
      // Eliminar el Plus Code al inicio si está
      nombre = formatted.replace(/^[A-Z0-9]{4,8}\+[A-Z0-9]+,?\s*/i, "").split(",")[0].trim();
    }

    return nombre || null;
  } catch {
    return null;
  }
}


// ─── DETECCIÓN DE TRÁFICO/BLOQUEOS EN TIEMPO REAL ───────────────────────────
// Consulta Google Distance Matrix con departure_time=now para obtener tiempo
// con tráfico real. Compara con el tiempo "sin tráfico" para detectar bloqueos.
async function verificarTraficoEnRuta(origen, destino) {
  try {
    const rutas = await calcularRutasConTrafico(origen, destino);
    if (!rutas.length) return null;
    const r = rutas[0];
    const sinTrafico = r.duracionSinTraficoSeg;
    const conTrafico = r.duracionSeg;
    const minutosSinTraf = Math.round(sinTrafico / 60);
    const minutosConTraf = Math.round(conTrafico / 60);
    const factorRetraso = sinTrafico > 0 ? conTrafico / sinTrafico : 1;
    // Severidad
    let severidad = "normal";
    if (factorRetraso >= 2.5) severidad = "bloqueo_grave";
    else if (factorRetraso >= 1.8) severidad = "trafico_pesado";
    else if (factorRetraso >= 1.4) severidad = "trafico_moderado";
    return {
      minutosSinTraf, minutosConTraf, factorRetraso,
      retrasoMin: minutosConTraf - minutosSinTraf,
      severidad,
      distanciaMetros: r.distanciaM || 0,
    };
  } catch (e) {
    log.warn("[TRAFICO]", e.message);
    return null;
  }
}



// ─── ROUTES API (reemplazo moderno de Directions, obligatorio en proyectos
// nuevos de Google Cloud donde la Directions legacy da REQUEST_DENIED) ───────
// Devuelve rutas con tráfico: [{duracionSeg, duracionSinTraficoSeg, distanciaM, via, puntos[]}]
// ordenadas como las entrega Google (la primera es la recomendada).
async function calcularRutasConTrafico(origen, destino, paradas = []) {
  const body = {
    origin: { location: { latLng: { latitude: origen.lat, longitude: origen.lng } } },
    destination: { location: { latLng: { latitude: destino.lat, longitude: destino.lng } } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: paradas.length === 0, // Google no da alternativas con paradas
    languageCode: "es",
    units: "METRIC",
  };
  if (paradas.length > 0) {
    body.intermediates = paradas.map(p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } }));
  }
  const res = await axios.post(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    body,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": CONFIG.GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.description,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation,routes.legs.steps.distanceMeters",
      },
      timeout: CONFIG.TIMEOUT_GOOGLE,
    }
  );
  return (res.data.routes || []).map(r => ({
    duracionSeg: parseInt(r.duration) || 0,                 // viene como "1234s"
    duracionSinTraficoSeg: parseInt(r.staticDuration) || parseInt(r.duration) || 0,
    distanciaM: r.distanceMeters || 0,
    via: r.description || "",
    polilineaCodificada: r.polyline?.encodedPolyline || null,
    puntos: r.polyline?.encodedPolyline ? decodificarPolyline(r.polyline.encodedPolyline) : [],
    // Maniobras paso a paso (para la navegación con voz del chofer)
    pasos: (r.legs || []).reduce((acc, leg) => acc.concat((leg.steps || []).map(s => ({
      instruccion: s.navigationInstruction?.instructions || "",
      maniobra: s.navigationInstruction?.maneuver || "",
      lat: s.startLocation?.latLng?.latitude,
      lng: s.startLocation?.latLng?.longitude,
      distanciaM: s.distanceMeters || 0,
    }))), []).filter(p => p.lat != null),
  }));
}

module.exports = { calcularRutasConTrafico, distanciaEntrePuntos, calcularTiempoConTrafico, obtenerRutaCompleta, distanciaARuta, decodificarPolyline, evaluarPrecisionReferencia, extraerCoordsDeUrlGmaps, resolverUrlCorta, extraerNombreLugarDeUrl, detectarYExtrarCoordsMaps, normalizarReferencia, generarTrigramas, similitudTexto, buscarReferenciaEnMemoria, guardarReferenciaVoz, dentroDeCocha, geocodificarConMemoria, calcularDistancia, calcularDistanciaConParadas, generarLinkRutaConParadas, generarLinkMapaPropio, geocodificarDireccion, obtenerDireccion, verificarTraficoEnRuta, obtenerRecargoSubida };
