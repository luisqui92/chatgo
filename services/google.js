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
  try {
    for (let i = 0; i < 8; i++) {
      const res = await axios.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 6000,
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

async function detectarYExtrarCoordsMaps(texto) {
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
        const geocoded = await geocodificarConMemoria(nombreLugar);
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
      return await geocodificarConMemoria(nombreLugar);
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

async function buscarReferenciaEnMemoria(referencia, ciudadUsuario = "Cochabamba") {
  if (!referencia || referencia.length < 4) return null;
  const norm = normalizarReferencia(referencia);

  // 1. Búsqueda exacta filtrada por ciudad
  const exacto = await LocationReference.findOne({ referencia: norm, ciudad: ciudadUsuario });
  // Fallback sin filtro de ciudad para referencias antiguas
  const exactoAny = exacto || await LocationReference.findOne({ referencia: norm });
  const docExacto = exacto || exactoAny;
  if (docExacto) {
    log.info(`[VOICE_MEM] Hit exacto: "${referencia}" en ${ciudadUsuario} → (${docExacto.lat}, ${docExacto.lng})`);
    await LocationReference.findByIdAndUpdate(docExacto._id, { $inc: { contador: 1 } });
    return { lat: docExacto.lat, lng: docExacto.lng, nombre: docExacto.nombreResuelto };
  }

  // 2. Búsqueda difusa — comparar similitud con todas las referencias
  // Solo si la referencia tiene más de 6 caracteres (evitar falsos positivos)
  if (norm.length < 6) return null;

  const todas = await LocationReference.find({}).lean();
  let mejorMatch = null;
  let mejorSimilitud = 0;
  const UMBRAL_SIMILITUD = 0.85; // 85% de similitud mínima — evita falsos positivos en calles

  for (const doc of todas) {
    const sim = similitudTexto(norm, doc.referencia);
    if (sim > mejorSimilitud) {
      mejorSimilitud = sim;
      mejorMatch = doc;
    }
  }

  if (mejorMatch && mejorSimilitud >= UMBRAL_SIMILITUD) {
    log.info(`[VOICE_MEM] Hit difuso: "${referencia}" ~ "${mejorMatch.referenciaOriginal}" (${Math.round(mejorSimilitud * 100)}%) → (${mejorMatch.lat}, ${mejorMatch.lng})`);
    // Guardar también la variante nueva para futuros usos
    await guardarReferenciaVoz(referencia, mejorMatch.lat, mejorMatch.lng, mejorMatch.nombreResuelto);
    return { lat: mejorMatch.lat, lng: mejorMatch.lng, nombre: mejorMatch.nombreResuelto };
  }

  return null;
}

async function guardarReferenciaVoz(referenciaOriginal, lat, lng, nombre, ciudadUsuario = "Cochabamba") {
  if (!referenciaOriginal || referenciaOriginal.length < 4) return;
  try {
    const norm = normalizarReferencia(referenciaOriginal);
    await LocationReference.findOneAndUpdate(
      { referencia: norm, ciudad: ciudadUsuario },
      {
        $set: { referenciaOriginal, lat, lng, nombreResuelto: nombre, ciudad: ciudadUsuario },
        $inc: { contador: 1 },
      },
      { upsert: true }
    );
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

async function geocodificarConMemoria(referencia, ciudadUsuario = "Cochabamba") {
  if (!referencia) return null;

  // 1. Buscar en memoria local filtrada por ciudad
  const enMemoria = await buscarReferenciaEnMemoria(referencia, ciudadUsuario);
  if (enMemoria) {
    log.info(`[VOICE_MEM] Cache hit: "${referencia}" (${ciudadUsuario})`);
    return enMemoria;
  }

  // 2. Geocodificar con Google Maps usando contexto de ciudad
  const coords = await geocodificarDireccion(referencia, true, ciudadUsuario);
  if (!coords) return null;

  // 3. Validar que el resultado esté dentro de la ciudad del usuario
  const boundsU = getBoundsUsuario(ciudadUsuario);
  const dentroDeZona = coords.lat >= boundsU.latMin && coords.lat <= boundsU.latMax &&
    coords.lng >= boundsU.lngMin && coords.lng <= boundsU.lngMax;
  if (!dentroDeZona) {
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

  // Ruta genérica sin intersección
  const esRutaGenerica = tipos.includes("route") && !tipos.includes("intersection") && !esConfiable;
  if (esRutaGenerica) {
    log.warn(`[GEOCOD] "${referencia}" → ruta genérica (${tipos.join(",")}) — requiere confirmación`);
    return { ...coords, _incierto: true };
  }

  // 5. Guardar en memoria para futuros usos
  await guardarReferenciaVoz(referencia, coords.lat, coords.lng, coords.nombre);
  return coords;
}

async function calcularDistancia(origen, destino) {
  try {
    const res = await axios.get(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      {
        params: {
          origins: `${origen.lat},${origen.lng}`,
          destinations: `${destino.lat},${destino.lng}`,
          key: CONFIG.GOOGLE_MAPS_KEY,
          mode: "driving",
        },
        timeout: CONFIG.TIMEOUT_GOOGLE,
      }
    );
    if (res.data.status !== "OK") throw new Error("fallback");
    const element = res.data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error("fallback");
    return {
      km: Math.round((element.distance.value / 1000) * 10) / 10,
      duracion: element.duration.text,
      esAproximado: false,
    };
  } catch {
    const km = Math.round(distanciaEntrePuntos(origen.lat, origen.lng, destino.lat, destino.lng) * 1.3 * 10) / 10;
    return { km, duracion: `~${Math.round(km * 3)} min`, esAproximado: true };
  }
}

// Calcula tiempo en ruta con tráfico en tiempo real
async function calcularTiempoConTrafico(origenLat, origenLng, destinoLat, destinoLng) {
  try {
    const res = await axios.get(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      {
        params: {
          origins: `${origenLat},${origenLng}`,
          destinations: `${destinoLat},${destinoLng}`,
          key: CONFIG.GOOGLE_MAPS_KEY,
          mode: "driving",
          departure_time: "now",
          traffic_model: "best_guess",
        },
        timeout: CONFIG.TIMEOUT_GOOGLE,
      }
    );
    if (res.data.status !== "OK") return null;
    const element = res.data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") return null;

    const duracionNormal = element.duration?.value || 0;       // segundos sin tráfico
    const duracionTrafico = element.duration_in_traffic?.value || duracionNormal; // segundos con tráfico
    const factorTrafico = duracionNormal > 0 ? duracionTrafico / duracionNormal : 1;

    return {
      minutosSinTrafico: Math.round(duracionNormal / 60),
      minutosConTrafico: Math.round(duracionTrafico / 60),
      factorTrafico: Math.round(factorTrafico * 100) / 100,
      hayTrafico: factorTrafico > 1.3, // más de 30% de demora = tráfico significativo
      distanciaKm: Math.round((element.distance?.value || 0) / 100) / 10,
    };
  } catch (e) {
    log.error("[TRAFICO]", e.message);
    return null;
  }
}

async function calcularDistanciaConParadas(origen, paradas, destino) {
  const puntos = [origen, ...(paradas || []), destino];
  let kmTotal = 0, minTotal = 0, huboFallback = false;

  for (let i = 0; i < puntos.length - 1; i++) {
    try {
      const res = await axios.get(
        "https://maps.googleapis.com/maps/api/distancematrix/json",
        {
          params: {
            origins: `${puntos[i].lat},${puntos[i].lng}`,
            destinations: `${puntos[i + 1].lat},${puntos[i + 1].lng}`,
            key: CONFIG.GOOGLE_MAPS_KEY,
            mode: "driving",
          },
          timeout: CONFIG.TIMEOUT_GOOGLE,
        }
      );
      const elem = res.data.rows?.[0]?.elements?.[0];
      if (res.data.status === "OK" && elem?.status === "OK") {
        kmTotal += elem.distance.value / 1000;
        minTotal += elem.duration.value / 60;
      } else throw new Error("fallback");
    } catch {
      const km = distanciaEntrePuntos(puntos[i].lat, puntos[i].lng, puntos[i+1].lat, puntos[i+1].lng);
      kmTotal += km * 1.3;
      minTotal += km * 3;
      huboFallback = true;
    }
  }

  return {
    km: Math.round(kmTotal * 10) / 10,
    duracion: `${Math.round(minTotal)} min`,
    esAproximado: huboFallback,
  };
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

async function geocodificarDireccion(direccion, reintentoInterseccion = true, ciudadUsuario = "Cochabamba") {
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
    const result = res.data.results[0];
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
      log.info(`[GEOCOD] Reintentando intersección: "${reformateado}"`);
      const reintento = await geocodificarDireccion(reformateado, false);
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
    const o = `${origen.lat},${origen.lng}`;
    const d = `${destino.lat},${destino.lng}`;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${o}&destinations=${d}&departure_time=now&traffic_model=best_guess&key=${CONFIG.GOOGLE_MAPS_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });
    const elem = res.data?.rows?.[0]?.elements?.[0];
    if (!elem || elem.status !== "OK") return null;
    const sinTrafico = elem.duration?.value || 0;       // segundos sin tráfico
    const conTrafico = elem.duration_in_traffic?.value || sinTrafico;
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
      distanciaMetros: elem.distance?.value || 0,
    };
  } catch (e) {
    log.warn("[TRAFICO]", e.message);
    return null;
  }
}


module.exports = { distanciaEntrePuntos, calcularTiempoConTrafico, evaluarPrecisionReferencia, extraerCoordsDeUrlGmaps, resolverUrlCorta, extraerNombreLugarDeUrl, detectarYExtrarCoordsMaps, normalizarReferencia, generarTrigramas, similitudTexto, buscarReferenciaEnMemoria, guardarReferenciaVoz, dentroDeCocha, geocodificarConMemoria, calcularDistancia, calcularDistanciaConParadas, generarLinkRutaConParadas, geocodificarDireccion, obtenerDireccion, verificarTraficoEnRuta };
