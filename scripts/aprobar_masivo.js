const http = require("http");
const https = require("https");

const MONGO_URI = "mongodb+srv://chatgo:chatgo2024@cluster0.vya3p9l.mongodb.net/chatgo";
const TRACCAR_USER = "Luis.qui92@gmail.com";
const TRACCAR_PASS = "Carlo1012.";
const GREEN_API_ID = "7107586637";
const GREEN_API_TOKEN = "b33613c1d7ff46888346c21c7b848d5c7ab3a74016b84c8783";
const APK_LINK = "https://drive.google.com/file/d/1f6ueNXW8soAAtiy4U1xyHC-I63D79hen/view?usp=drivesdk";
const BOT_VIAJES = "59162741818";

const authHeader = "Basic " + Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function traccarRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "34.61.45.154", port: 8082, path, method,
      headers: {
        "Authorization": authHeader, "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      },
    };
    const req = http.request(options, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function enviarWhatsApp(phone, mensaje) {
  return new Promise((resolve, reject) => {
    const chatId = phone + "@c.us";
    const body = JSON.stringify({ chatId, message: mensaje });
    const options = {
      hostname: "api.green-api.com",
      path: `/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { console.log(`  📤 WhatsApp ${phone}: ${d}`); resolve(d); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db("chatgo");

  const registros = await db.collection("choferregistros").find({
    aprobado: false,
    rechazado: { $ne: true },
    nombre: { $exists: true },
    placa: { $exists: true },
    ci: { $exists: true },
    licenciaVencimiento: { $exists: true },
    soatVencimiento: { $exists: true }
  }).toArray();

  console.log(`Aprobando y notificando ${registros.length} choferes...`);
  let ok = 0, errores = 0;

  for (const reg of registros) {
    const phone = reg.phone;
    const uniqueId = phone.startsWith("591") ? phone.slice(3) : phone;
    const nombre = `${(reg.placa || "").toUpperCase()} - ${(reg.nombre || "Chofer").split(" ")[0]}`;
    const nombreCorto = (reg.nombre || "Conductor").split(" ")[0];

    try {
      // 1. Crear o verificar dispositivo Traccar
      const existing = await traccarRequest("GET", `/api/devices?uniqueId=${uniqueId}`);
      let deviceId;
      if (Array.isArray(existing) && existing.length > 0) {
        deviceId = existing[0].id;
        console.log(`  EXISTE ${nombre} → id=${deviceId}`);
      } else {
        const device = await traccarRequest("POST", "/api/devices", { name: nombre, uniqueId });
        deviceId = device.id;
        if (!deviceId) throw new Error("Sin ID Traccar");
        console.log(`  CREADO ${nombre} → id=${deviceId}`);
      }

      // 2. Aprobar en MongoDB
      await db.collection("choferregistros").updateOne(
        { _id: reg._id },
        { $set: {
          aprobado: true, aprobadoAt: new Date(),
          traccarCreado: true, traccarDeviceId: deviceId, traccarUniqueId: uniqueId,
        }}
      );

      // 3. Crear en colección chofers
      await db.collection("chofers").findOneAndUpdate(
        { phone },
        { $set: {
          phone, nombre: reg.nombre, placa: reg.placa,
          traccarId: String(deviceId),
          tipoVehiculo: reg.tipoVehiculo || "auto",
          aceptoTerminos: true, estado: "offline",
        }},
        { upsert: true }
      );

      // 4. Enviar mensaje de bienvenida por WhatsApp
      const msg =
        `🎉 *¡FELICITACIONES ${nombreCorto.toUpperCase()}!*\n\n` +
        `Tu registro como conductor de ChatGo fue *APROBADO* ✅\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `📱 *PASO 1 — Instala ChatgoTrack*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `Descarga e instala la app:\n${APK_LINK}\n\n` +
        `_(Descomprime el .zip e instala el .apk)_\n\n` +
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

      await enviarWhatsApp(phone, msg);
      ok++;
      await sleep(2000); // 2s entre mensajes para no ser bloqueado

    } catch (e) {
      console.error(`  ❌ ERROR ${phone}: ${e.message}`);
      errores++;
    }
  }

  console.log(`\n✅ Completado: ${ok} aprobados y notificados, ${errores} errores`);
  await client.close();
}

main().catch(console.error);
