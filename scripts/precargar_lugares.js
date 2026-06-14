// Script para PRE-CARGAR lugares conocidos geocodificando con Google Maps.
// Uso: node scripts/precargar_lugares.js "Santa Cruz"
// Google da las coordenadas REALES (no inventadas). Solo guarda las que caen
// dentro de los límites de la ciudad (descarta errores de geocodificación).

require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");
const { CONFIG, CIUDADES, getBoundsUsuario, getContextoGeocode } = require("../config");
const { LocationReference } = require("../db/models");
const { normalizarReferencia } = require("../services/google");

// ─── LISTAS DE LUGARES POR CIUDAD ────────────────────────────────────────────
// Nombres tal como la gente los dice. Google los convierte a coordenadas.
const LUGARES = {
  "Santa Cruz": [
    // Plazas y puntos céntricos
    "Plaza 24 de Septiembre", "Plaza del Estudiante", "Plaza Blacutt", "Plazuela del Mechero",
    "Parque Urbano Central", "Parque El Arenal", "Parque de la Familia", "Plaza Callejas",
    // Anillos y avenidas principales (intersecciones más usadas)
    "Segundo Anillo y Avenida Cristo Redentor", "Tercer Anillo y Avenida Banzer",
    "Cuarto Anillo y Avenida Banzer", "Primer Anillo y Avenida Cañoto",
    "Avenida Cristo Redentor y Cuarto Anillo", "Avenida Alemana y Tercer Anillo",
    "Avenida Roca y Coronado", "Avenida Monseñor Rivero", "Avenida San Martín y Segundo Anillo",
    "Avenida Busch y Tercer Anillo", "Avenida Irala", "Avenida Cañoto",
    "Doble Vía La Guardia", "Avenida Virgen de Cotoca", "Avenida Grigotá",
    "Avenida Santos Dumont", "Avenida Piraí", "Avenida Beni y Tercer Anillo",
    "Avenida Mutualista", "Avenida Radial 26", "Avenida Radial 17 y medio",
    // Universidades
    "Universidad Autónoma Gabriel René Moreno", "UAGRM", "Universidad UPSA",
    "Universidad Nur", "Universidad Católica Boliviana Santa Cruz", "Universidad Domingo Savio",
    "Universidad UDABOL Santa Cruz", "Universidad Evangélica Boliviana",
    // Hospitales y clínicas
    "Hospital San Juan de Dios", "Hospital Japonés", "Hospital de Niños Mario Ortiz",
    "Hospital Universitario Japonés", "Clínica Foianini", "Clínica Incor",
    "Clínica Niño Jesús", "Hospital Oncológico", "Caja Petrolera de Salud Santa Cruz",
    // Centros comerciales y supermercados
    "Ventura Mall", "Las Brisas Shopping", "Shopping Norte", "Patio Design",
    "Hipermaxi Norte", "Hipermaxi Cañoto", "Fidalga Monseñor Rivero", "IC Norte Santa Cruz",
    "Mall Las Brisas", "Megacenter Santa Cruz",
    // Mercados
    "Mercado Los Pozos", "Mercado La Ramada", "Mercado Mutualista", "Mercado Abasto",
    "Mercado Florida", "Mercado Siete Calles", "Mercado Nuevo Mundo",
    // Terminales y transporte
    "Terminal Bimodal Santa Cruz", "Terminal de Buses Santa Cruz",
    "Aeropuerto Viru Viru", "Aeropuerto El Trompillo",
    // Estadios y deportes
    "Estadio Ramón Tahuichi Aguilera", "Estadio Real Santa Cruz",
    "Coliseo Polideportivo", "Club Las Palmas", "Club de Tenis Santa Cruz",
    // Zonas y barrios conocidos
    "Equipetrol", "Barrio Las Palmas", "Plan Tres Mil", "Villa Primero de Mayo",
    "Barrio Urbarí", "Zona Norte Santa Cruz", "Barrio Sirari", "Las Palmas Equipetrol",
    // Iglesias y referencias
    "Catedral de Santa Cruz", "Iglesia de Jesús Nazareno", "Cristo Redentor Santa Cruz",
    "Manzana Uno", "Casco Viejo Santa Cruz", "Cambódromo",
    // Centros importantes
    "Fexpocruz", "Recinto Ferial Fexpocruz", "Palacio de Justicia Santa Cruz",
    "Gobierno Municipal Santa Cruz", "Cementerio General Santa Cruz",
  ],
  "Cochabamba": [
    "Plaza 14 de Septiembre", "Plaza Colón", "Plaza de las Banderas", "Plazuela Cobija",
    "Plazuela Constitución", "Plazuela Busch", "Plaza Recoleta", "Plazuela Quintanilla",
    "Cristo de la Concordia", "Cancha Cochabamba", "La Pampa mercado", "Mercado Calatayud",
    "Mercado San Antonio", "Mercado 25 de Mayo", "Coronilla",
    "Universidad Mayor de San Simón", "Universidad Católica Boliviana Cochabamba",
    "Universidad Privada Boliviana", "Universidad del Valle Tiquipaya", "UNIVALLE Cochabamba",
    "Hospital Viedma", "Hospital Univalle", "Hospital Materno Infantil Germán Urquidi",
    "Clínica Los Olivos", "Clínica Belga", "Hospital del Niño Cochabamba",
    "Terminal de Buses Cochabamba", "Aeropuerto Jorge Wilstermann",
    "Cine Center Cochabamba", "IC Norte Cochabamba", "Hipermaxi Cala Cala",
    "Mall Las Américas", "Multicine Cochabamba", "Estadio Félix Capriles",
    "Avenida América y Pando", "Avenida Heroínas y San Martín", "Avenida Ayacucho y Calama",
    "Avenida Blanco Galindo", "Avenida Villazón", "Avenida Juan de la Rosa",
    "Plaza Sucre", "Plaza Granado", "Avenida Aroma", "Avenida Oquendo",
    "Cala Cala", "Queru Queru", "Tupuraya", "Sarco", "Muyurina", "Temporal",
    "Quillacollo plaza", "Tiquipaya plaza", "Sacaba terminal", "Vinto plaza",
    "Recoleta", "El Prado Cochabamba", "Plaza Principal Quillacollo",
  ],
};

async function geocodificar(nombre, ciudad) {
  const contexto = getContextoGeocode(ciudad);
  const b = getBoundsUsuario(ciudad);
  const boundsStr = `${b.latMin},${b.lngMin}|${b.latMax},${b.lngMax}`;
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: `${nombre}, ${contexto}`,
        key: CONFIG.GOOGLE_MAPS_KEY,
        bounds: boundsStr,
        region: "BO",
        language: "es",
      },
      timeout: 15000,
    });
    if (!res.data.results?.length) return { ok: false, motivo: "sin_resultados" };

    const result = res.data.results[0];
    const loc = result.geometry.location;

    // Verificar que caiga DENTRO de los límites de la ciudad (descartar errores)
    const dentro = loc.lat >= b.latMin && loc.lat <= b.latMax &&
                   loc.lng >= b.lngMin && loc.lng <= b.lngMax;
    if (!dentro) return { ok: false, motivo: "fuera_de_ciudad", lat: loc.lat, lng: loc.lng };

    // Descartar resultados demasiado genéricos (solo el país o la ciudad entera)
    const tipos = result.types || [];
    if (tipos.includes("country") || tipos.includes("administrative_area_level_1")) {
      return { ok: false, motivo: "muy_generico" };
    }

    return {
      ok: true,
      lat: loc.lat,
      lng: loc.lng,
      nombre: result.formatted_address,
      tipos: tipos.join(","),
    };
  } catch (e) {
    return { ok: false, motivo: "error", error: e.message };
  }
}

async function main() {
  const ciudad = process.argv[2] || "Santa Cruz";
  const lista = LUGARES[ciudad];
  if (!lista) {
    console.error(`No hay lista para "${ciudad}". Ciudades disponibles: ${Object.keys(LUGARES).join(", ")}`);
    process.exit(1);
  }

  if (!CONFIG.GOOGLE_MAPS_KEY) {
    console.error("Falta GOOGLE_MAPS_KEY en las variables de entorno.");
    process.exit(1);
  }

  await mongoose.connect(CONFIG.MONGODB_URI);
  console.log(`✅ Conectado a MongoDB`);

  // Migrar índice viejo (referencia única global) → nuevo (referencia+ciudad).
  // Si existe el índice viejo, lo eliminamos para que funcione el compuesto.
  try {
    const indices = await LocationReference.collection.indexes();
    const viejo = indices.find(i => i.name === "referencia_1" && i.unique);
    if (viejo) {
      await LocationReference.collection.dropIndex("referencia_1");
      console.log("🔧 Índice viejo 'referencia_1' eliminado (migración a referencia+ciudad).");
    }
    // Asegurar el índice compuesto
    await LocationReference.collection.createIndex({ referencia: 1, ciudad: 1 }, { unique: true });
  } catch (e) {
    console.log("ℹ️  Aviso al migrar índices:", e.message);
  }

  console.log(`📍 Pre-cargando ${lista.length} lugares de ${ciudad}...\n`);

  let guardados = 0, descartados = 0, errores = 0;
  const fallidos = [];

  for (const nombre of lista) {
    const r = await geocodificar(nombre, ciudad);
    if (r.ok) {
      const norm = normalizarReferencia(nombre);
      await LocationReference.findOneAndUpdate(
        { referencia: norm, ciudad },
        {
          $set: {
            referenciaOriginal: nombre,
            lat: r.lat,
            lng: r.lng,
            nombreResuelto: r.nombre,
            ciudad,
            precargado: true,
          },
          $setOnInsert: { contador: 5 }, // contador alto = confiable
        },
        { upsert: true }
      );
      console.log(`✅ ${nombre} → (${r.lat.toFixed(5)}, ${r.lng.toFixed(5)})`);
      guardados++;
    } else {
      console.log(`⚠️  ${nombre} — DESCARTADO (${r.motivo})`);
      if (r.motivo === "fuera_de_ciudad" || r.motivo === "sin_resultados") descartados++;
      else errores++;
      fallidos.push(`${nombre} (${r.motivo})`);
    }
    // Pausa corta para no saturar la API de Google
    await new Promise(res => setTimeout(res, 120));
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Guardados:   ${guardados}`);
  console.log(`⚠️  Descartados: ${descartados}`);
  console.log(`❌ Errores:     ${errores}`);
  if (fallidos.length) {
    console.log(`\nLugares que no se cargaron:`);
    fallidos.forEach(f => console.log(`  - ${f}`));
  }

  await mongoose.disconnect();
  console.log(`\n🏁 Listo. ${guardados} lugares de ${ciudad} están en la memoria de ChatGo.`);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
