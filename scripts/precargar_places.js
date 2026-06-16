// Pre-carga MASIVA de lugares usando Google Places API (Text Search).
// Barre la ciudad por CATEGORÍAS (hospitales, universidades, mercados, etc.) y
// Google devuelve decenas de lugares reales de cada tipo, con coordenadas reales.
//
// Uso: node scripts/precargar_places.js "Santa Cruz"
//
// Requiere Places API habilitada en Google Cloud (places-backend.googleapis.com).
// Cada búsqueda devuelve hasta 20 lugares y se paginan hasta 3 páginas (60 max).

require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");
const { CONFIG, CIUDADES, getBoundsUsuario } = require("../config");
const { LocationReference } = require("../db/models");
const { normalizarReferencia } = require("../services/google");

// Categorías a barrer (en español, como las dice la gente). Por cada una,
// Google Places devuelve los lugares reales de ese tipo en la ciudad.
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
        radius: 25000, // 25 km alrededor del centro de la ciudad
      };
      if (pageToken) params.pagetoken = pageToken;

      const res = await axios.get(
        "https://maps.googleapis.com/maps/api/place/textsearch/json",
        { params, timeout: 15000 }
      );

      if (res.data.status === "REQUEST_DENIED") {
        console.error(`\n❌ Places API DENEGADA: ${res.data.error_message || "revisa que esté habilitada y la API key permita Places"}`);
        return { error: "REQUEST_DENIED", lugares: [] };
      }
      if (res.data.status === "OK" || res.data.status === "ZERO_RESULTS") {
        for (const r of (res.data.results || [])) {
          lugares.push({
            nombre: r.name,
            lat: r.geometry?.location?.lat,
            lng: r.geometry?.location?.lng,
            direccion: r.formatted_address || "",
            tipos: (r.types || []).join(","),
          });
        }
      }
      pageToken = res.data.next_page_token || null;
      pagina++;
      // Google exige una pausa antes de usar el next_page_token
      if (pageToken) await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`  error en "${categoria}": ${e.message}`);
      break;
    }
  } while (pageToken && pagina < 3);

  return { lugares };
}

async function main() {
  const ciudad = process.argv[2] || "Santa Cruz";
  const cfg = CIUDADES[ciudad];
  if (!cfg) {
    console.error(`Ciudad "${ciudad}" no configurada. Disponibles: ${Object.keys(CIUDADES).join(", ")}`);
    process.exit(1);
  }
  if (!CONFIG.GOOGLE_MAPS_KEY) {
    console.error("Falta GOOGLE_MAPS_KEY.");
    process.exit(1);
  }

  const centro = cfg.centro || { lat: (cfg.bounds.latMin + cfg.bounds.latMax) / 2, lng: (cfg.bounds.lngMin + cfg.bounds.lngMax) / 2 };
  const b = getBoundsUsuario(ciudad);

  await mongoose.connect(CONFIG.MONGODB_URI);
  console.log(`✅ Conectado a MongoDB`);

  // Migrar índice viejo si existe
  try {
    const idx = await LocationReference.collection.indexes();
    if (idx.find(i => i.name === "referencia_1" && i.unique)) {
      await LocationReference.collection.dropIndex("referencia_1");
      console.log("🔧 Índice viejo eliminado.");
    }
    await LocationReference.collection.createIndex({ referencia: 1, ciudad: 1 }, { unique: true });
  } catch (e) { console.log("ℹ️ ", e.message); }

  console.log(`📍 Barriendo ${ciudad} por ${CATEGORIAS.length} categorías con Places API...\n`);

  const vistos = new Set();
  let guardados = 0, descartados = 0;

  for (const categoria of CATEGORIAS) {
    const { lugares, error } = await buscarCategoria(categoria, ciudad, centro);
    if (error === "REQUEST_DENIED") {
      console.error("\n🛑 Detenido: Places API no está disponible. Actívala y reintenta.");
      break;
    }

    let nuevosEnCat = 0;
    for (const lug of lugares) {
      if (!lug.lat || !lug.lng) continue;

      // Verificar que caiga dentro de la ciudad
      const dentro = lug.lat >= b.latMin && lug.lat <= b.latMax &&
                     lug.lng >= b.lngMin && lug.lng <= b.lngMax;
      if (!dentro) { descartados++; continue; }

      const norm = normalizarReferencia(lug.nombre);
      if (!norm || norm.length < 3) continue;
      const clave = `${norm}|${ciudad}`;
      if (vistos.has(clave)) continue; // ya lo guardamos en otra categoría
      vistos.add(clave);

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
      nuevosEnCat++;
    }
    console.log(`  ${categoria}: ${nuevosEnCat} nuevos (total: ${guardados})`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Guardados: ${guardados} lugares reales de ${ciudad}`);
  console.log(`⚠️  Descartados (fuera de zona): ${descartados}`);

  await mongoose.disconnect();
  console.log(`\n🏁 Listo. ChatGo ahora conoce ${guardados} lugares de ${ciudad}.`);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
