// ChatGo — Seed de mecánicos de PRUEBA para Auxilio Mecánico
// Carga 10 expertos por cada área (50 en total), todos ubicados en Cochabamba.
// Idempotente: se puede correr varias veces (upsert por teléfono).
//
//   node scripts/seed_mecanicos.js

const { Mecanico } = require("../db/models");

const CBBA = { lat: -17.3895, lng: -66.1568 };
const ZONAS = ["Cala Cala", "Queru Queru", "Sarco", "Temporal", "Av. América", "Hipódromo", "Muyurina", "La Recoleta", "El Prado", "Villa Busch"];
const AREAS = [
  { tipo: "llanta",           prefijo: "Llantería" },
  { tipo: "bateria",          prefijo: "Baterías" },
  { tipo: "mecanica_general", prefijo: "Taller Mecánico" },
  { tipo: "grua",             prefijo: "Grúas" },
  { tipo: "cerrajeria",       prefijo: "Cerrajería Automotriz" },
];
const NOMBRES = ["Don Juan", "El Rápido", "Central", "San Cristóbal", "Los Andes", "El Chapa", "24 Horas", "La Bendición", "El Experto", "Popular"];

async function run() {
  let idx = 0, creados = 0;
  for (const area of AREAS) {
    for (let k = 0; k < 10; k++) {
      const telefono = "5917" + String(1000000 + idx); // 591 7XXXXXXX único
      const nombre = `${area.prefijo} ${NOMBRES[k]}`;
      // Ubicación: dispersa por Cochabamba (~±3 km del centro)
      const lat = CBBA.lat + (Math.random() - 0.5) * 0.055;
      const lng = CBBA.lng + (Math.random() - 0.5) * 0.055;
      const atiende24h = k % 3 === 0; // ~1 de cada 3, 24h
      const tiposServicio = area.tipo === "mecanica_general"
        ? ["mecanica_general"]
        : [area.tipo, "mecanica_general"]; // los especialistas también hacen general

      const datos = {
        nombre,
        zona: ZONAS[k % ZONAS.length] + " (Cochabamba)",
        ubicacionBase: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
        tiposServicio,
        atiende24h,
        documentos: { facturaLuz: true, carnet: true, nit: null, verificacionFisica: true, notasVerificacion: "Mecánico de prueba (seed)" },
        suscripcion: {
          estado: "mes_gratis",
          fechaInicio: new Date().toISOString(),
          fechaVencimiento: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        },
        calificacionPromedio: Math.round((4.2 + Math.random() * 0.8) * 10) / 10,
        activo: true,
      };

      await Mecanico.upsert({
        where: { telefono },
        update: datos,
        create: { telefono, ...datos },
      });
      creados++;
      idx++;
    }
  }
  console.log(`✅ ${creados} mecánicos de prueba cargados (10 por área, en Cochabamba).`);
  process.exit(0);
}

run().catch((e) => { console.error("Error en el seed:", e.message); process.exit(1); });
