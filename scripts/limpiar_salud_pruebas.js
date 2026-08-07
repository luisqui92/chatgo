// Borra las consultas médicas viejas que quedaron del prototipo antes de que
// existiera Paciente (no tienen pacienteId — son datos de prueba, no sirven
// para nada con el esquema nuevo). No toca médicos ni pacientes.
// Uso:      node scripts/limpiar_salud_pruebas.js            (solo diagnóstico)
// Aplicar:  node scripts/limpiar_salud_pruebas.js --aplicar

const mongoose = require("mongoose");
const { CONFIG } = require("../config");
const { ConsultaMedica } = require("../db/models");

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  await mongoose.connect(CONFIG.MONGODB_URI);
  console.log("✅ Conectado a MongoDB\n");

  const huerfanas = await ConsultaMedica.find({ pacienteId: { $exists: false } }).lean();
  console.log(`Consultas sin paciente ligado (formato viejo, de antes del Kardex): ${huerfanas.length}`);
  huerfanas.forEach(c => console.log(`   "${c.pacienteNombre || "(sin nombre)"}" — ${c.createdAt}`));

  if (!aplicar) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Esto fue solo un DIAGNÓSTICO. No se borró nada.`);
    console.log(`Para borrarlas de verdad: node scripts/limpiar_salud_pruebas.js --aplicar`);
    await mongoose.disconnect();
    return;
  }

  const r = await ConsultaMedica.deleteMany({ pacienteId: { $exists: false } });
  console.log(`\n🗑️  Borradas: ${r.deletedCount}`);
  await mongoose.disconnect();
  console.log(`\n🏁 Listo.`);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
