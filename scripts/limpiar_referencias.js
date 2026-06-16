// Limpia referencias de ubicación mal etiquetadas: las que dicen estar en una
// ciudad pero cuyas coordenadas caen en otra (o fuera de toda ciudad conocida).
// Estos datos viejos contaminan las búsquedas. Uso: node scripts/limpiar_referencias.js
// Para borrar de verdad: node scripts/limpiar_referencias.js --aplicar

require("dotenv").config();
const mongoose = require("mongoose");
const { CONFIG, CIUDADES } = require("../config");
const { LocationReference } = require("../db/models");

function ciudadPorCoords(lat, lng) {
  for (const [nombre, c] of Object.entries(CIUDADES)) {
    const b = c.bounds;
    if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) return nombre;
  }
  return null;
}

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  await mongoose.connect(CONFIG.MONGODB_URI);
  console.log(`✅ Conectado a MongoDB\n`);

  const todas = await LocationReference.find({}).lean();
  console.log(`Total de referencias: ${todas.length}\n`);

  const malEtiquetadas = [];
  const fueraDeTodo = [];

  for (const ref of todas) {
    if (ref.lat == null || ref.lng == null) continue;
    const ciudadReal = ciudadPorCoords(ref.lat, ref.lng);
    if (ciudadReal === null) {
      fueraDeTodo.push(ref);
    } else if (ref.ciudad !== ciudadReal) {
      malEtiquetadas.push({ ref, ciudadReal });
    }
  }

  console.log(`🔴 Mal etiquetadas (ciudad guardada ≠ ciudad de las coords): ${malEtiquetadas.length}`);
  malEtiquetadas.slice(0, 30).forEach(({ ref, ciudadReal }) => {
    console.log(`   "${ref.referenciaOriginal}" → guardada en ${ref.ciudad}, pero coords son de ${ciudadReal}`);
  });
  if (malEtiquetadas.length > 30) console.log(`   ... y ${malEtiquetadas.length - 30} más`);

  console.log(`\n🟡 Fuera de toda ciudad conocida: ${fueraDeTodo.length}`);
  fueraDeTodo.slice(0, 15).forEach(ref => {
    console.log(`   "${ref.referenciaOriginal}" (${ref.ciudad}) → (${ref.lat}, ${ref.lng})`);
  });

  if (!aplicar) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Esto fue solo un DIAGNÓSTICO. No se borró nada.`);
    console.log(`La opción más segura es CORREGIR la etiqueta (no borrar).`);
    console.log(`\nPara CORREGIR las mal etiquetadas (cambiar a su ciudad real):`);
    console.log(`   node scripts/limpiar_referencias.js --aplicar`);
    await mongoose.disconnect();
    return;
  }

  // Aplicar: CORREGIR la ciudad de las mal etiquetadas (más seguro que borrar)
  let corregidas = 0;
  for (const { ref, ciudadReal } of malEtiquetadas) {
    // Verificar que no exista ya esa referencia en la ciudad correcta (evitar choque de índice)
    const existe = await LocationReference.findOne({ referencia: ref.referencia, ciudad: ciudadReal });
    if (existe) {
      // Ya existe en la ciudad correcta — borrar el duplicado mal etiquetado
      await LocationReference.deleteOne({ _id: ref._id });
    } else {
      await LocationReference.updateOne({ _id: ref._id }, { $set: { ciudad: ciudadReal } });
    }
    corregidas++;
  }

  // Borrar las que están fuera de toda ciudad (datos basura)
  let borradas = 0;
  for (const ref of fueraDeTodo) {
    await LocationReference.deleteOne({ _id: ref._id });
    borradas++;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Corregidas (reasignadas a su ciudad real): ${corregidas}`);
  console.log(`🗑️  Borradas (fuera de toda ciudad): ${borradas}`);
  await mongoose.disconnect();
  console.log(`\n🏁 Listo. Base de referencias limpia.`);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
