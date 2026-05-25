// ChatGo — Schemas MongoDB
const mongoose = require("mongoose");
const { CONFIG, log } = require("../config");

mongoose.connect(CONFIG.MONGODB_URI).then(
  () => log.info("✅ MongoDB conectado"),
  (e) => log.error("❌ MongoDB:", e.message)
);

const usuarioSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    nombre: String,
    aceptoTerminos: { type: Boolean, default: false },
    fechaRegistro: { type: Date, default: Date.now },
    audioOnboardingHecho: { type: Boolean, default: false },
  ciudad: { type: String, default: null }, // "Cochabamba", "La Paz", "Santa Cruz", etc.
  ciudadDetectada: { type: Boolean, default: false }, // si fue detectada automáticamente
    viajesTotal: { type: Number, default: 0 },
    rutasFrecuentes: [
      {
        origen: { lat: Number, lng: Number, nombre: String },
        destino: { lat: Number, lng: Number, nombre: String },
        contador: { type: Number, default: 1 },
      },
    ],
  },
  { timestamps: true }
);

const choferSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    wialonId: { type: String, unique: true, sparse: true, index: true },
    placa: String,
    nombre: String,
    tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto", index: true },
    colorVehiculo: { type: String, default: "" },
    estado: { type: String, default: "offline", index: true },
    pagoDiario: {
      fecha: Date,
      fechaStr: String,
      pagado: { type: Boolean, default: false },
      aprobado: { type: Boolean, default: false },
      comprobanteValidado: { type: Boolean, default: false },
    },
    viajesTotal: { type: Number, default: 0 },
    aceptoTerminos: { type: Boolean, default: false },
    fechaRegistro: { type: Date, default: Date.now },
    viajeReservado: { type: String, default: null },
    reservadoHasta: Date,
    ratingPromedio: { type: Number, default: 0 },
    ratingCantidad: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const viajeSchema = new mongoose.Schema(
  {
    usuarioPhone: { type: String, index: true },
    choferPhone: { type: String, index: true },
    choferWialonId: { type: String, index: true },
    choferNombre: String,
    choferPlaca: String,
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    paradas: [{ lat: Number, lng: Number, nombre: String }],
    observaciones: String,
    distanciaKm: Number,
    precioBase: Number,
    descuentoBs: { type: Number, default: 0 },
    codigoPromoUsado: String,
    precioTotal: Number,
    precioPorKm: Number,
    tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto" },
    estado: { type: String, default: "pendiente", index: true },
    fechaInicio: { type: Date, default: Date.now },
    fechaAsignacion: Date,
    fechaAceptacion: Date,
    fechaFin: Date,
    llegadaNotificada: { type: Boolean, default: false },
    llegadaOrigenNotificada: { type: Boolean, default: false },
    cancelacionMotivo: String,
    ratingPasajero: Number,
    comentarioPasajero: String,
    ratingSolicitado: { type: Boolean, default: false },
    codigoPromoGenerado: String,
  },
  { timestamps: true }
);

const codigoPromoSchema = new mongoose.Schema(
  {
    codigo: { type: String, unique: true, index: true, uppercase: true },
    descuentoPorcentaje: { type: Number, default: 40 },
    generadoPor: { type: String, index: true },
    tipoOrigen: { type: String, default: "post_viaje" },
    fechaCreacion: { type: Date, default: Date.now },
    fechaVencimiento: { type: Date, index: true },
    usado: { type: Boolean, default: false, index: true },
    usadoPor: String,
    fechaUso: Date,
    viajeIdAsociado: String,
  },
  { timestamps: true }
);

const sessionSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const listaEsperaSchema = new mongoose.Schema(
  {
    userPhone: { type: String, unique: true, index: true },
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    distancia: Number,
    precio: Number,
    precioPorKm: Number,
    tipoVehiculoSolicitado: { type: String, enum: ["auto", "moto", null], default: null },
    timestamp: { type: Date, default: Date.now },
    notificado: { type: Boolean, default: false },
    ofertaActivaWialonId: { type: String, default: null },
    ofertaActivaHasta: { type: Date, default: null },
    ofertasRechazadas: { type: [String], default: [] },
    ultimoMensajeAt: { type: Date, default: null }, // para no spamear al usuario
    cancelando: { type: Boolean, default: false }, // flag atómico para evitar race condition
  },
  { timestamps: true }
);

const rateLimitSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    horaStr: String,
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// FEATURE: Schema para memoria de referencias de voz
const locationReferenceSchema = new mongoose.Schema(
  {
    referencia: { type: String, unique: true, index: true }, // normalizada
    referenciaOriginal: String,
    lat: Number,
    lng: Number,
    nombreResuelto: String,
    contador: { type: Number, default: 1 },
    ciudad: { type: String, default: "Cochabamba" },
  },
  { timestamps: true }
);

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const SessionState = mongoose.model("SessionState", sessionSchema, "sessionstates");
const ListaEspera = mongoose.model("ListaEspera", listaEsperaSchema, "listaesperas");
const RateLimit = mongoose.model("RateLimit", rateLimitSchema, "ratelimits");
const CodigoPromo = mongoose.model("CodigoPromo", codigoPromoSchema, "codigospromo");
const LocationReference = mongoose.model("LocationReference", locationReferenceSchema, "locationreferences");

module.exports = { Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference };
