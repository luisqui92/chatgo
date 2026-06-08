const https = require("https");

const MONGO_URI = "mongodb+srv://chatgo:chatgo2024@cluster0.vya3p9l.mongodb.net/chatgo";
const GREEN_API_ID = "7107586637";
const GREEN_API_TOKEN = "b33613c1d7ff46888346c21c7b848d5c7ab3a74016b84c8783";
const APK_LINK = "https://drive.google.com/file/d/1f6ueNXW8soAAtiy4U1xyHC-I63D79hen/view?usp=drivesdk";
const BOT_VIAJES = "59162741818";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      res.on("end", () => { console.log(`  📤 ${phone}: ${d}`); resolve(d); });
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

  // Obtener choferes con traccarId (migrados de wialon)
  const choferes = await db.collection("chofers").find({
    traccarId: { $exists: true, $ne: null },
    phone: { $exists: true }
  }).toArray();

  console.log(`Notificando ${choferes.length} choferes...`);
  let ok = 0, errores = 0;

  for (const chofer of choferes) {
    const phone = chofer.phone;
    const uniqueId = phone.startsWith("591") ? phone.slice(3) : phone;
    const nombreCorto = (chofer.nombre || "Conductor").split(" ")[0];

    try {
      const msg =
        `👋 *Hola ${nombreCorto}!*\n\n` +
        `📢 *Aviso importante de ChatGo*\n\n` +
        `Hemos migrado nuestro sistema de seguimiento GPS. *Ya no usaremos WiaTag* — ahora usamos nuestra propia app: *ChatgoTrack* 🚀\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `📱 *PASO 1 — Instala ChatgoTrack*\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `Descarga e instala la nueva app:\n${APK_LINK}\n\n` +
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
        `Cuando ChatgoTrack esté activo, escribe al bot:\n` +
        `📱 https://wa.me/${BOT_VIAJES}\n\n` +
        `⚠️ *WiaTag ya no funcionará con ChatGo.* Por favor instala ChatgoTrack antes de tu próximo turno.\n\n` +
        `¿Dudas? Escribe al +591 62741818 🚖`;

      await enviarWhatsApp(phone, msg);
      ok++;
      await sleep(2000);

    } catch (e) {
      console.error(`  ❌ ERROR ${phone}: ${e.message}`);
      errores++;
    }
  }

  console.log(`\n✅ Completado: ${ok} notificados, ${errores} errores`);
  await client.close();
}

main().catch(console.error);
