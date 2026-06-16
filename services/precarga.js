// Módulo de pre-carga de lugares con Google Places API.
// Lo usan tanto el script (scripts/precargar_places.js) como el comando de
// WhatsApp del admin ("cargar santa cruz"). Devuelve un resumen de lo cargado.

const axios = require("axios");
const { CONFIG, CIUDADES, getBoundsUsuario, log } = require("../config");
const { LocationReference } = require("../db/models");
const { normalizarReferencia } = require("../services/google");

const CATEGORIAS = [
  "hospitales", "clínicas", "centros de salud", "universidades", "colegios",
  "mercados", "supermercados", "centros comerciales", "shopping",
  "plazas", "parques", "terminales de buses", "farmacias", "bancos",
  "gasolineras", "hoteles", "restaurantes", "gimnasios", "iglesias",
  "cines", "estadios", "coliseos", "museos", "bibliotecas",
  "aeropuerto", "ferias", "cementerios", "comida rápida", "cafeterías",
  "heladerías", "panaderías", "veterinarias", "ferreterías", "librerías",
  "barrios", "avenidas principales", "centros culturales", "polideportivos",
];

async function buscarCategoria(categoria, ciudad, centro) {
  const contexto = (CIUDADES[ciudad] || {}).contextoGeocode || ciudad;
  const lugares = [];
  let pageToken = null;
  let pagina = 0;

  do {
    try {
      const params = {
        query: `${categoria} en ${contexto}`,
        key: CONFIG.GOOGLE_MAPS_KEY,
        language: "es",
        region: "BO",
        location: `${centro.lat},${centro.lng}`,
        radius: 25000,
      };
      if (pageToken) params.pagetoken = pageToken;

      const res = await axios.get(
        "https://maps.googleapis.com/maps/api/place/textsearch/json",
        { params, timeout: 15000 }
      );

      if (res.data.status === "REQUEST_DENIED") {
        return { error: "REQUEST_DENIED", mensaje: res.data.error_message, lugares: [] };
      }
      if (res.data.status === "OK" || res.data.status === "ZERO_RESULTS") {
        for (const r of (res.data.results || [])) {
          lugares.push({
            nombre: r.name,
            lat: r.geometry?.location?.lat,
            lng: r.geometry?.location?.lng,
            direccion: r.formatted_address || "",
          });
        }
      }
      pageToken = res.data.next_page_token || null;
      pagina++;
      if (pageToken) await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      log.error(`[PRECARGA] error en "${categoria}": ${e.message}`);
      break;
    }
  } while (pageToken && pagina < 3);

  return { lugares };
}

// Asegura el índice compuesto correcto (migra el viejo si existe)
async function asegurarIndice() {
  try {
    const idx = await LocationReference.collection.indexes();
    if (idx.find(i => i.name === "referencia_1" && i.unique)) {
      await LocationReference.collection.dropIndex("referencia_1");
    }
    await LocationReference.collection.createIndex({ referencia: 1, ciudad: 1 }, { unique: true });
  } catch (e) { log.warn("[PRECARGA] índice:", e.message); }
}

// Carga todos los lugares de una ciudad. onProgreso(texto) es opcional (para avisar al admin).
async function precargarCiudad(ciudad, onProgreso = null) {
  const cfg = CIUDADES[ciudad];
  if (!cfg) return { error: "CIUDAD_NO_CONFIGURADA", guardados: 0 };
  if (!CONFIG.GOOGLE_MAPS_KEY) return { error: "SIN_API_KEY", guardados: 0 };

  const centro = cfg.centro || {
    lat: (cfg.bounds.latMin + cfg.bounds.latMax) / 2,
    lng: (cfg.bounds.lngMin + cfg.bounds.lngMax) / 2,
  };
  const b = getBoundsUsuario(ciudad);

  await asegurarIndice();

  const vistos = new Set();
  let guardados = 0, descartados = 0;

  for (let i = 0; i < CATEGORIAS.length; i++) {
    const categoria = CATEGORIAS[i];
    const { lugares, error, mensaje } = await buscarCategoria(categoria, ciudad, centro);
    if (error === "REQUEST_DENIED") {
      return { error: "REQUEST_DENIED", mensaje, guardados };
    }

    for (const lug of lugares) {
      if (!lug.lat || !lug.lng) continue;
      const dentro = lug.lat >= b.latMin && lug.lat <= b.latMax &&
                     lug.lng >= b.lngMin && lug.lng <= b.lngMax;
      if (!dentro) { descartados++; continue; }

      const norm = normalizarReferencia(lug.nombre);
      if (!norm || norm.length < 3) continue;
      const clave = `${norm}|${ciudad}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      try {
        await LocationReference.findOneAndUpdate(
          { referencia: norm, ciudad },
          {
            $set: {
              referenciaOriginal: lug.nombre,
              lat: lug.lat,
              lng: lug.lng,
              nombreResuelto: lug.direccion || lug.nombre,
              ciudad,
              precargado: true,
            },
            $setOnInsert: { contador: 5 },
          },
          { upsert: true }
        );
        guardados++;
      } catch (e) { /* duplicado u otro — ignorar */ }
    }

    // Avisar progreso cada 10 categorías
    if (onProgreso && (i + 1) % 10 === 0) {
      await onProgreso(`Cargando ${ciudad}... ${guardados} lugares hasta ahora (${i + 1}/${CATEGORIAS.length} categorías)`);
    }
  }

  return { guardados, descartados };
}

module.exports = { precargarCiudad, CATEGORIAS };
