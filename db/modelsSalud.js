// ChatGo Salud — modelos con conexión a MongoDB PROPIA, separada de la de
// taxis/choferes/pasajeros (db/models.js). Otro cluster, otras credenciales:
// nada de datos de consultas médicas comparte base de datos con el bot de taxi.
const mongoose = require("mongoose");
const { CONFIG, log } = require("../config");

let conexionSalud = null;

if (CONFIG.MONGODB_URI_SALUD) {
  conexionSalud = mongoose.createConnection(CONFIG.MONGODB_URI_SALUD, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000,
    maxPoolSize: 10,
    minPoolSize: 2,
  });
  conexionSalud.on("connected", () => log.info("✅ MongoDB Salud conectado (cluster separado de taxis)"));
  conexionSalud.on("error", (e) => log.error("❌ MongoDB Salud:", e.message));
  conexionSalud.on("disconnected", () => log.warn("⚠️ MongoDB Salud desconectado, reintentando..."));
} else {
  log.warn("⚠️  MONGODB_URI_SALUD no configurado — el módulo de consultas médicas no va a funcionar hasta que lo configures.");
}

const medicoSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true, required: true },
  nombre: { type: String, required: true },
  especialidad: { type: String, default: "" },
  passwordHash: { type: String, required: true },
  activo: { type: Boolean, default: true },
}, { timestamps: true });

// Una consulta médica transcrita: audio subido por el médico, diarizado
// (separa quién habla) por AssemblyAI.
const consultaMedicaSchema = new mongoose.Schema({
  medicoPhone: { type: String, index: true, required: true },
  pacienteNombre: { type: String, default: "" },
  estado: { type: String, enum: ["procesando", "completado", "error"], default: "procesando", index: true },
  duracionSegundos: Number,
  transcripcionCompleta: String,
  segmentos: [{
    hablante: String,   // "A", "B"... según lo que detecta AssemblyAI (no sabe cuál es médico/paciente)
    texto: String,
    inicioSeg: Number,
    finSeg: Number,
  }],
  error: String,
}, { timestamps: true });
consultaMedicaSchema.index({ medicoPhone: 1, createdAt: -1 });

// Si no hay conexión configurada todavía, exportamos null: las rutas de
// /medico/* lo detectan y devuelven 503 en vez de tirar abajo el servidor.
const Medico = conexionSalud ? conexionSalud.model("Medico", medicoSchema) : null;
const ConsultaMedica = conexionSalud ? conexionSalud.model("ConsultaMedica", consultaMedicaSchema) : null;

module.exports = { Medico, ConsultaMedica };
