// ChatGo — Alta de SUPERCHOFERES de prueba directamente desde el VM.
//
// Pensado para testers/programadores que NO van a hacer el alta por WhatsApp
// ni van a manejar. El script hace TODO lo necesario para que el número reciba
// órdenes de trabajo por WhatsApp y aparezca en la secuencia de asignación:
//   1. Crea (o reutiliza) su dispositivo GPS en Traccar (uniqueId = teléfono).
//   2. Le carga una posición inicial en Cochabamba vía protocolo OsMand, para
//      que tenga GPS "en vivo" sin instalar ninguna app.
//   3. Da de alta / actualiza el chofer en la base como SUPERCHOFER
//      (tipoVehiculo="todo", estado="libre", términos aceptados, pago del día
//      aprobado) para que reciba taxi, moto, van, delivery y ambulancia.
//
// Uso en el VM (uno por persona; el nombre es opcional):
//   cd ~/chatgo-app
//   node scripts/alta_superchofer.js 59164637067 Luis
//   node scripts/alta_superchofer.js 59176900697 Ada
//   node scripts/alta_superchofer.js 59160703991 Ana
//
// Recordá tenerlos también en CHOFER_PRUEBA_PHONE (.env) para el forzado.

const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Cargar .env (este script corre suelto, no pasa por index.js) ────────────
(function cargarEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    for (const linea of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
})();

const prisma = require("../db/prisma");

const TRACCAR_URL = process.env.TRACCAR_URL || "http://34.61.45.154:8082";
const TRACCAR_USER = process.env.TRACCAR_USER || "";
const TRACCAR_PASS = process.env.TRACCAR_PASS || "";
const OSMAND_PORT = Number(process.env.OSMAND_PORT || 5055);
const OFFSET_HORAS = -4; // Bolivia UTC-4

const { hostname: TRACCAR_HOST, port: TRACCAR_PORT } = new URL(TRACCAR_URL);
const authHeader = "Basic " + Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");

function fechaStrBolivia() {
  return new Date(Date.now() + OFFSET_HORAS * 3600 * 1000).toISOString().slice(0, 10);
}

// Cochabamba centro + un pequeño desplazamiento determinístico por teléfono,
// para que cada superchofer quede en un punto distinto y la secuencia (por
// cercanía al pasajero) sea observable y estable entre corridas.
function coordDe(phone) {
  const n = parseInt(phone.slice(-4), 10) || 0;
  return {
    lat: -17.3895 + (((n % 20) - 10) * 0.0018),
    lng: -66.1568 + (((n % 17) - 8) * 0.0018),
  };
}

function traccarReq(method, ruta, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: TRACCAR_HOST, port: TRACCAR_PORT || 8082, path: ruta, method,
        headers: {
          Authorization: authHeader, Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(d ? JSON.parse(d) : null); } catch { resolve(d); } });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Enviar una posición por el protocolo OsMand (puerto 5055 por defecto)
function enviarPosicionOsmand(uniqueId, lat, lng) {
  const ts = Math.floor(Date.now() / 1000);
  const ruta = `/?id=${encodeURIComponent(uniqueId)}&lat=${lat}&lon=${lng}&timestamp=${ts}&hdop=1&altitude=2560&speed=0&accuracy=5`;
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: TRACCAR_HOST, port: OSMAND_PORT, path: ruta, method: "POST" },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode)); }
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function altaUno(phone, nombre) {
  const uniqueId = phone.startsWith("591") ? phone.slice(3) : phone;
  const { lat, lng } = coordDe(phone);

  // 1. Dispositivo Traccar (crear o reutilizar)
  let deviceId = null;
  try {
    const existentes = await traccarReq("GET", `/api/devices?uniqueId=${uniqueId}`);
    if (Array.isArray(existentes) && existentes.length) {
      deviceId = existentes[0].id;
      console.log(`  · Dispositivo Traccar ya existía → id=${deviceId}`);
    } else {
      const dev = await traccarReq("POST", "/api/devices", { name: `TEST ${nombre} (${uniqueId})`, uniqueId });
      if (dev?.id) { deviceId = dev.id; console.log(`  · Dispositivo Traccar creado → id=${deviceId}`); }
      else { console.log(`  ⚠️ No se pudo crear el dispositivo Traccar: ${JSON.stringify(dev)}`); }
    }
  } catch (e) {
    console.log(`  ⚠️ Error con Traccar (¿TRACCAR_USER/PASS en el .env?): ${e.message}`);
  }

  // 2. Posición inicial vía OsMand (para que tenga GPS en vivo sin app)
  if (deviceId) {
    const code = await enviarPosicionOsmand(uniqueId, lat, lng);
    if (code >= 200 && code < 300) console.log(`  · Posición GPS inicial cargada en ${lat.toFixed(4)},${lng.toFixed(4)} (OsMand ${code})`);
    else console.log(`  ⚠️ No se pudo cargar la posición (OsMand puerto ${OSMAND_PORT} respondió ${code}). ` +
      `Igual queda dado de alta; la posición se llenará cuando el celular abra la app de GPS, o reintentá con OSMAND_PORT correcto.`);
  }

  // 3. Chofer en la base como SUPERCHOFER
  const hoy = fechaStrBolivia();
  const datos = {
    nombre, tipoVehiculo: "todo", estado: "libre", aceptoTerminos: true,
    placa: `TEST-${uniqueId.slice(-4)}`, colorVehiculo: "",
    pagoDiarioPagado: true, pagoDiarioAprobado: true, pagoDiarioComprobanteValidado: true,
    pagoDiarioFechaStr: hoy, pagoDiarioFecha: new Date(),
    ...(deviceId ? { traccarId: String(deviceId) } : {}),
  };
  await prisma.chofer.upsert({ where: { phone }, create: { phone, ...datos }, update: datos });

  const gps = deviceId ? `GPS traccarId=${deviceId}` : "⚠️ SIN GPS (Traccar no disponible)";
  console.log(`  ✅ ${nombre} (${phone}) dado de alta como SUPERCHOFER (tipoVehiculo="todo", libre, pago ${hoy}). ${gps}`);
}

async function main() {
  const [phone, nombre] = process.argv.slice(2);
  if (!phone) {
    console.log('Uso: node scripts/alta_superchofer.js <telefono con 591> [nombre]');
    process.exit(1);
  }
  console.log(`Dando de alta superchofer ${phone}...`);
  await altaUno(phone, nombre || `Tester ${phone.slice(-4)}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
