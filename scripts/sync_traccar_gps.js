// ChatGo — Re-alinear el traccarId de los choferes con el Traccar NUEVO.
//
// Contexto: al migrar de servidor, el Traccar nuevo asigna IDs numéricos nuevos a
// cada dispositivo, así que el `traccarId` que quedó en MySQL (del Traccar viejo)
// deja de coincidir. Este script corrige eso SIN tocar los datos reales del chofer:
// busca su dispositivo en el Traccar nuevo por uniqueId (= su teléfono) y sobrescribe
// únicamente `chofer.traccarId` con el id numérico correcto del server nuevo.
//
// El uniqueId de cada dispositivo es el teléfono SIN el prefijo 591 (igual que en
// scripts/alta_superchofer.js), para que coincida con cómo se nombraron los GPS.
//
// Uso en el VM (dentro de ~/chatgo-app):
//   node scripts/sync_traccar_gps.js --crear 59179159396 59177544022
//        → SOLO esos teléfonos: crea el dispositivo si falta y fija su traccarId.
//          (así arrancan los 2 superchoferes del piloto)
//
//   node scripts/sync_traccar_gps.js --crear
//        → TODOS los choferes de la base: crea el dispositivo que falte y realinea
//          el traccarId de cada uno (para cuando re-vinculen los 93).
//
//   node scripts/sync_traccar_gps.js
//        → TODOS, pero SIN crear: solo realinea a los que ya tengan dispositivo.
//
//   Flags:  --crear   crea el dispositivo en Traccar si no existe (uniqueId = teléfono)
//           --dry-run no escribe nada (ni en Traccar ni en MySQL), solo informa
//
// Requiere en el .env: TRACCAR_URL, TRACCAR_USER, TRACCAR_PASS.

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

const TRACCAR_URL = process.env.TRACCAR_URL || "http://localhost:8082";
const TRACCAR_USER = process.env.TRACCAR_USER || "";
const TRACCAR_PASS = process.env.TRACCAR_PASS || "";
const { hostname: TRACCAR_HOST, port: TRACCAR_PORT } = new URL(TRACCAR_URL);
const authHeader = "Basic " + Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");

const args = process.argv.slice(2);
const CREAR = args.includes("--crear");
const DRY_RUN = args.includes("--dry-run");
const PHONES = args.filter((a) => !a.startsWith("--"));

// uniqueId = teléfono sin el prefijo 591 (igual criterio que alta_superchofer.js)
function uniqueIdDe(phone) {
  return String(phone).startsWith("591") ? String(phone).slice(3) : String(phone);
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
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          try { resolve({ ok, status: res.statusCode, body: d ? JSON.parse(d) : null }); }
          catch { resolve({ ok, status: res.statusCode, body: d }); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sincronizarUno(chofer) {
  const { phone, nombre, traccarId: idViejo } = chofer;
  const uniqueId = uniqueIdDe(phone);
  const etiqueta = `${nombre || "Chofer"} (${phone})`;

  // 1. ¿Ya existe el dispositivo en el Traccar nuevo?
  let dev = null;
  try {
    const r = await traccarReq("GET", `/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`);
    if (r.ok && Array.isArray(r.body) && r.body.length) dev = r.body[0];
  } catch (e) {
    console.log(`  ⚠️ ${etiqueta}: error consultando Traccar (${e.message}). ¿TRACCAR_URL/USER/PASS del .env?`);
    return { estado: "error" };
  }

  // 2. Crear si falta y se pidió --crear
  if (!dev) {
    if (!CREAR) {
      console.log(`  ·  ${etiqueta}: sin dispositivo en Traccar nuevo (usá --crear para crearlo).`);
      return { estado: "sin_dispositivo" };
    }
    if (DRY_RUN) {
      console.log(`  +  ${etiqueta}: [dry-run] se crearía dispositivo uniqueId=${uniqueId}.`);
      return { estado: "creado_dry" };
    }
    try {
      const r = await traccarReq("POST", "/api/devices", { name: nombre || `Chofer ${uniqueId}`, uniqueId });
      if (r.ok && r.body?.id) { dev = r.body; console.log(`  +  ${etiqueta}: dispositivo creado → id=${dev.id}`); }
      else { console.log(`  ⚠️ ${etiqueta}: no se pudo crear (HTTP ${r.status}): ${JSON.stringify(r.body)}`); return { estado: "error" }; }
    } catch (e) {
      console.log(`  ⚠️ ${etiqueta}: error creando dispositivo (${e.message}).`);
      return { estado: "error" };
    }
  }

  // 3. Realinear el traccarId si cambió
  const idNuevo = String(dev.id);
  if (String(idViejo || "") === idNuevo) {
    console.log(`  =  ${etiqueta}: traccarId ya correcto (${idNuevo}).`);
    return { estado: "ok_sin_cambio" };
  }
  if (DRY_RUN) {
    console.log(`  ~  ${etiqueta}: [dry-run] traccarId ${idViejo || "∅"} → ${idNuevo}.`);
    return { estado: "actualizado_dry" };
  }
  await prisma.chofer.update({ where: { phone }, data: { traccarId: idNuevo } });
  console.log(`  ✅ ${etiqueta}: traccarId ${idViejo || "∅"} → ${idNuevo}${dev.positionId ? " (con GPS en vivo ✔️)" : " (aún sin posición; reportará al abrir su app)"}`);
  return { estado: "actualizado" };
}

async function main() {
  if (!TRACCAR_USER || !TRACCAR_PASS) {
    console.error("❌ Faltan TRACCAR_USER / TRACCAR_PASS en el .env.");
    process.exit(1);
  }
  console.log(`🔌 Traccar destino: ${TRACCAR_URL}${DRY_RUN ? "  (DRY-RUN)" : ""}${CREAR ? "  [crear=ON]" : ""}\n`);

  let choferes;
  if (PHONES.length) {
    const norm = PHONES.map((p) => {
      const d = String(p).replace(/\D/g, "");
      return d.length === 8 ? "591" + d : d;
    });
    choferes = await prisma.chofer.findMany({ where: { phone: { in: norm } } });
    const encontrados = new Set(choferes.map((c) => c.phone));
    for (const p of norm) if (!encontrados.has(p)) console.log(`  ⚠️ ${p}: no está registrado como chofer en la base (omitido).`);
  } else {
    choferes = await prisma.chofer.findMany();
  }

  console.log(`Sincronizando ${choferes.length} chofer(es)...\n`);
  const conteo = {};
  for (const c of choferes) {
    const { estado } = await sincronizarUno(c);
    conteo[estado] = (conteo[estado] || 0) + 1;
  }

  console.log("\n" + "─".repeat(50));
  console.log("RESUMEN:", JSON.stringify(conteo));
  console.log("─".repeat(50));
  await prisma.$disconnect();
}

main().catch((e) => { console.error("❌ Error fatal:", e); process.exit(1); });
