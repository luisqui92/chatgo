// Script de migración: Wialon → Traccar para 62 choferes
// Ejecutar en SSH de Google Cloud: node /tmp/migration_script.js

const https = require("https");
const http = require("http");

const MONGO_URI = "mongodb+srv://chatgo:chatgo2024@cluster0.vya3p9l.mongodb.net/chatgo";
const TRACCAR_URL = "http://34.61.45.154:8082";
const TRACCAR_USER = "Luis.qui92@gmail.com";
const TRACCAR_PASS = "Carlo1012.";

const authHeader = "Basic " + Buffer.from(`${TRACCAR_USER}:${TRACCAR_PASS}`).toString("base64");

async function crearDispositivoTraccar(nombre, uniqueId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: nombre, uniqueId });
    const options = {
      hostname: "34.61.45.154",
      port: 8082,
      path: "/api/devices",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.id) resolve(parsed);
          else reject(new Error(`Sin ID: ${data}`));
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
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

  // Obtener los 62 choferes con wialonId pero sin traccarId
  const choferes = await db.collection("chofers").find({
    wialonId: { $exists: true },
    traccarId: { $exists: false }
  }).toArray();

  console.log(`Migrando ${choferes.length} choferes...`);

  let ok = 0, error = 0, yaExiste = 0;

  for (const chofer of choferes) {
    const phone = chofer.phone;
    const uniqueId = phone.startsWith("591") ? phone.slice(3) : phone;
    const nombre = `${(chofer.placa || "").toUpperCase()} - ${(chofer.nombre || "Chofer").split(" ")[0]}`;

    try {
      // Verificar si ya existe en Traccar
      const checkRes = await new Promise((resolve, reject) => {
        const options = {
          hostname: "34.61.45.154",
          port: 8082,
          path: `/api/devices?uniqueId=${uniqueId}`,
          method: "GET",
          headers: { "Authorization": authHeader },
        };
        const req = http.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(JSON.parse(data)));
        });
        req.on("error", reject);
        req.end();
      });

      let deviceId;
      if (checkRes.length > 0) {
        deviceId = checkRes[0].id;
        yaExiste++;
        console.log(`  EXISTE ${nombre} → id=${deviceId}`);
      } else {
        const device = await crearDispositivoTraccar(nombre, uniqueId);
        deviceId = device.id;
        console.log(`  OK ${nombre} → id=${deviceId}`);
      }

      // Actualizar MongoDB
      await db.collection("chofers").updateOne(
        { _id: chofer._id },
        { $set: { traccarId: String(deviceId) } }
      );
      ok++;

      // Pausa para no saturar Traccar
      await new Promise(r => setTimeout(r, 300));

    } catch (e) {
      console.error(`  ERROR ${nombre}: ${e.message}`);
      error++;
    }
  }

  console.log(`\n✅ Migración completa: ${ok} ok, ${yaExiste} ya existían, ${error} errores`);
  await client.close();
}

main().catch(console.error);
