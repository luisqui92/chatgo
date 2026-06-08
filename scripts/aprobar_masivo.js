// Script de aprobación masiva de 25 choferes completos
// Ejecutar: cd /tmp/migra && node /tmp/aprobar_masivo.js

const http = require("http");
const MONGO_URI = "mongodb+srv://chatgo:chatgo2024@cluster0.vya3p9l.mongodb.net/chatgo";
const TRACCAR_URL = "http://34.61.45.154:8082";
const TRACCAR_USER = "Luis.qui92@gmail.com";
const TRACCAR_PASS = "Carlo1012.";
const GREENAPI_INSTANCE = process.env.GREENAPI_INSTANCE;
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN;
const APK_LINK = "https://drive.google.com/file/d/1f6ueNXW8soAAtiy4U1xyHC-I63D79hen/view?usp=drivesdk";
const BOT_VIAJES = "59162741818"; // número del bot de viajes

const authHeader = "Basic " + Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function traccarRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "34.61.45.154",
      port: 8082,
      path,
      method,
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      },
    };
    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function enviarMensaje(phone, mensaje) {
  // Usar la API de GreenAPI o WhatsApp directamente
  // Como no tenemos acceso directo, guardamos en un archivo para envío manual
  return; // se maneja por el bot
}

async function main() {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db("chatgo");

  // Obtener los 25 completos
  const registros = await db.collection("choferregistros").find({
    aprobado: false,
    rechazado: { $ne: true },
    nombre: { $exists: true },
    placa: { $exists: true },
    ci: { $exists: true },
    licenciaVencimiento: { $exists: true },
    soatVencimiento: { $exists: true }
  }).toArray();

  console.log(`Aprobando ${registros.length} choferes...`);
  let ok = 0, errores = 0;

  for (const reg of registros) {
    const phone = reg.phone;
    const uniqueId = phone.startsWith("591") ? phone.slice(3) : phone;
    const nombre = `${(reg.placa || "").toUpperCase()} - ${(reg.nombre || "Chofer").split(" ")[0]}`;

    try {
      // 1. Verificar si ya tiene dispositivo en Traccar
      const existing = await traccarRequest("GET", `/api/devices?uniqueId=${uniqueId}`);
      let deviceId;

      if (Array.isArray(existing) && existing.length > 0) {
        deviceId = existing[0].id;
        console.log(`  EXISTE ${nombre} → id=${deviceId}`);
      } else {
        const device = await traccarRequest("POST", "/api/devices", { name: nombre, uniqueId });
        deviceId = device.id;
        if (!deviceId) throw new Error("Sin ID: " + JSON.stringify(device));
        console.log(`  CREADO ${nombre} → id=${deviceId}`);
      }

      // 2. Aprobar en registro
      await db.collection("choferregistros").updateOne(
        { _id: reg._id },
        { $set: {
          aprobado: true,
          aprobadoAt: new Date(),
          traccarCreado: true,
          traccarDeviceId: deviceId,
          traccarUniqueId: uniqueId,
        }}
      );

      // 3. Crear/actualizar en colección chofers
      await db.collection("chofers").findOneAndUpdate(
        { phone },
        { $set: {
          phone,
          nombre: reg.nombre,
          placa: reg.placa,
          traccarId: String(deviceId),
          tipoVehiculo: reg.tipoVehiculo || "auto",
          aceptoTerminos: true,
          estado: "offline",
        }},
        { upsert: true, new: true }
      );

      // 4. Guardar mensaje a enviar
      const nombreCorto = (reg.nombre || "Conductor").split(" ")[0];
      const emoji = reg.tipoVehiculo === "moto" ? "🏍️" : "🚗";
      const msg = `🎉 *¡FELICITACIONES ${nombreCorto.toUpperCase()}!*\n\n` +
        `Tu registro como conductor de ChatGo fue *APROBADO* ✅\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `📱 *PASO 1 — Instala ChatgoTrack*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `Descarga e instala la app desde este link:\n${APK_LINK}\n\n` +
        `*(Es un archivo .zip, descomprímelo e instala el .apk)*\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `🔑 *PASO 2 — Tu identificador*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `Abre ChatgoTrack → toca *"Identificador de dispositivo"* y escribe:\n\n` +
        `\`\`\`${uniqueId}\`\`\`\n\n` +
        `La URL del servidor ya viene configurada ✅\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *PASO 3 — Permisos*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `📍 Ubicación: *"Permitir todo el tiempo"*\n` +
        `🔋 Optimización de batería: *DESACTIVAR* para ChatgoTrack\n` +
        `🔄 Inicio automático: *ACTIVAR*\n` +
        `Activa *"Estado despierto forzado"* dentro de la app\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `🚀 *PASO 4 — Empieza a trabajar*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `Escribe al bot de choferes:\n` +
        `📱 https://wa.me/${BOT_VIAJES}\n\n` +
        `¿Dudas? Escribe al +591 62741818 🚖`;

      // Guardar en archivo para revisión
      const fs = require("fs");
      fs.appendFileSync("/tmp/mensajes_pendientes.txt",
        `\n=== ${phone} - ${reg.nombre} ===\n${msg}\n`
      );

      ok++;
      console.log(`  ✅ ${reg.nombre} (${phone}) aprobado`);
      await sleep(500);

    } catch (e) {
      console.error(`  ❌ ERROR ${phone}: ${e.message}`);
      errores++;
    }
  }

  console.log(`\n✅ Completado: ${ok} aprobados, ${errores} errores`);
  console.log(`📄 Mensajes guardados en /tmp/mensajes_pendientes.txt`);
  console.log(`\n⚠️  Debes enviar manualmente los mensajes desde el bot o WhatsApp`);
  await client.close();
}

main().catch(console.error);
