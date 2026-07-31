// ChatGo — Alta rápida de VARIOS superchoferes reales de una sola corrida.
//
// Un superchofer: recibe CUALQUIER tipo de servicio (tipoVehiculo="todo") y
// queda EXENTO del pago diario (su número entra en CHOFER_PRUEBA_PHONE del .env).
//
// A diferencia de scripts/alta_superchofer.js (pensado para testers, pone placa
// TEST y siembra GPS falso), este script está pensado para choferes REALES:
//   · Si el chofer YA se registró por WhatsApp, respeta su placa/vehículo/GPS
//     reales y solo lo marca como superchofer (tipoVehiculo="todo").
//   · Si todavía no se registró, avisa que debe mandar "soy chofer" por WhatsApp
//     y vincular su GPS para poder recibir viajes (igual lo deja en el .env).
//   · Agrega los números a CHOFER_PRUEBA_PHONE del .env para la exención de pago
//     (sin borrar los que ya estaban), y recuerda reiniciar con pm2.
//
// Uso en el VM (sin argumentos usa los dos de esta tanda):
//   cd ~/chatgo-app
//   node scripts/alta_superchoferes.js
//   # o personalizado:  node scripts/alta_superchoferes.js "59179159396:Juan Pablo Bedregal" "59177544022:Diego Cossio"
//   pm2 restart chatgo   # necesario para que tome la exención del .env

const fs = require("fs");
const path = require("path");

// Cargar .env (este script corre suelto, no pasa por index.js)
const ENV_PATH = path.join(__dirname, "..", ".env");
(function cargarEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    for (const linea of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
})();

const prisma = require("../db/prisma");

// Superchoferes de esta tanda (por defecto). phone:Nombre
const POR_DEFECTO = [
  "59179159396:Juan Pablo Bedregal",
  "59177544022:Diego Cossio",
];

// Normaliza a formato boliviano con prefijo 591 (celular de 8 dígitos).
function normalizarPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 8) d = "591" + d;          // solo el celular
  if (d.length === 11 && d.startsWith("591")) return d;
  return d; // otros formatos: se deja tal cual (el operador revisa el aviso)
}

function fechaStrBolivia() {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

async function marcarUno(phone, nombre) {
  const chofer = await prisma.chofer.findUnique({ where: { phone } });
  if (chofer) {
    const data = { tipoVehiculo: "todo" };
    if (!chofer.nombre && nombre) data.nombre = nombre;
    await prisma.chofer.update({ where: { phone }, data });
    const gps = chofer.traccarId ? `GPS OK (traccarId ${chofer.traccarId})` : "⚠️ SIN GPS — debe vincular su app para recibir viajes";
    console.log(`  ✅ ${nombre} (${phone}): marcado SUPERCHOFER (tipoVehiculo="todo"), placa real respetada (${chofer.placa || "s/placa"}). ${gps}`);
    return true;
  }
  // No registrado todavía: lo dejamos anotado en el .env y avisamos.
  console.log(`  ⚠️ ${nombre} (${phone}): NO está registrado como chofer todavía. Que mande "soy chofer" por WhatsApp y vincule su GPS. Igual queda exento en el .env.`);
  return false;
}

// Fusiona los números nuevos en la línea CHOFER_PRUEBA_PHONE del .env sin perder
// los que ya estaban. Si la línea no existe, la crea preservando el valor actual.
function actualizarEnv(phones) {
  let contenido = "";
  try { contenido = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : ""; } catch (_) {}
  const actuales = (process.env.CHOFER_PRUEBA_PHONE || "").split(",").map(s => s.trim()).filter(Boolean);
  const set = [];
  for (const p of [...actuales, ...phones]) if (p && !set.includes(p)) set.push(p);
  const nuevaLinea = `CHOFER_PRUEBA_PHONE=${set.join(",")}`;

  const lineas = contenido.split("\n");
  let encontrada = false;
  for (let i = 0; i < lineas.length; i++) {
    if (/^\s*CHOFER_PRUEBA_PHONE\s*=/.test(lineas[i])) { lineas[i] = nuevaLinea; encontrada = true; break; }
  }
  if (!encontrada) { if (contenido && !contenido.endsWith("\n")) lineas.push(""); lineas.push(nuevaLinea); }

  try {
    fs.writeFileSync(ENV_PATH, lineas.join("\n"));
    console.log(`\n  · .env actualizado → CHOFER_PRUEBA_PHONE=${set.join(",")}`);
  } catch (e) {
    console.log(`\n  ⚠️ No pude escribir el .env (${e.message}). Agregá a mano: ${nuevaLinea}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const entradas = (args.length ? args : POR_DEFECTO).map(x => {
    const i = x.indexOf(":");
    const rawPhone = i >= 0 ? x.slice(0, i) : x;
    const nombre = i >= 0 ? x.slice(i + 1).trim() : "";
    return { phone: normalizarPhone(rawPhone), nombre: nombre || `Chofer ${normalizarPhone(rawPhone).slice(-4)}` };
  });

  console.log(`Dando de alta ${entradas.length} superchofer(es)...\n`);
  const phones = [];
  for (const { phone, nombre } of entradas) {
    if (phone.length < 8) { console.log(`  ⚠️ Número inválido: ${phone}`); continue; }
    await marcarUno(phone, nombre);
    phones.push(phone);
  }

  actualizarEnv(phones);
  console.log(`\n  ➜ Reiniciá para que tome la exención de pago:  pm2 restart chatgo`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
