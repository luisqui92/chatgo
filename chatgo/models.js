const mongoose = require("mongoose");
const { CONFIG, log } = require("./config");

mongoose
  .connect(CONFIG.MONGODB_URI)
  .then(() => log.info("✅ MongoDB conectado"))
  .catch((e) => log.error("❌ Error MongoDB:", e.message));

// ─── USUARIO ────────────────────────────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true },
  nombre: String,
  aceptoTerminos: { type: Boolean, default: false },
  fechaRegistro: { type: Date, default: Date.now },
  viajesTotal: { type: Number, default: 0 },
  audioOnboardingHecho: { type: Boolean, default: false },
  rutasFrecuentes: [{
    origen: { lat: Number, lng: Number, nombre: String },
    destino: { lat: Number, lng: Number, nombre: String },
    contador: { type: Number, default: 1 },
  }],
  // IA reactivación
  ultimoViajeAt: Date,
  promoReactivacionEnviada: { type: Boolean, default: false },
}, { timestamps: true });

// ─── CHOFER ─────────────────────────────────────────────────────────────────
const choferSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true },
  wialonId: { type: String, unique: true, sparse: true, index: true },
  placa: String,
  nombre: String,
  tipoVehiculo: { type: String, enum: ["auto", "moto"], default: "auto", index: true },
  colorVehiculo: { type: String, default: "" },
  estado: { type: String, default: "offline", index: true },
  pagoDiario: {
    fecha: Date, fechaStr: String,
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
  // IA despacho inteligente
  tasaAceptacion: { type: Number, default: null },   // % de ofertas aceptadas
  tasaCancelacion: { type: Number, default: null },  // % de viajes cancelados
  tiempoPromedioAceptacion: { type: Number, default: null }, // segundos
  zonasConocidas: [String],  // zonas donde más trabaja
  ultimaZona: String,
  scoreDespacho: { type: Number, default: 50 }, // 0-100, empieza en 50
}, { timestamps: true });

// ─── VIAJE ──────────────────────────────────────────────────────────────────
const viajeSchema = new mongoose.Schema({
  usuarioPhone: { type: String, index: true },
  choferPhone: { type: String, index: true },
  choferWialonId: { type: String, index: true },
  choferNombre: String, choferPlaca: String,
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
  fechaAsignacion: Date, fechaAceptacion: Date, fechaFin: Date,
  llegadaNotificada: { type: Boolean, default: false },
  llegadaOrigenNotificada: { type: Boolean, default: false },
  cancelacionMotivo: String,
  ratingPasajero: Number, comentarioPasajero: String,
  ratingSolicitado: { type: Boolean, default: false },
  terminacionAnticipada: { type: Boolean, default: false },
  terminacionVoluntariaPasajero: { type: Boolean, default: null },
  codigoPromoGenerado: String,
  // IA pricing
  precioSurge: { type: Number, default: 1.0 },
  motivoSurge: String,
  // IA seguridad
  alertaSeguridad: { type: Boolean, default: false },
  tiempoEspera: Number, // segundos que esperó el pasajero
}, { timestamps: true });

// ─── CÓDIGO PROMO ────────────────────────────────────────────────────────────
const codigoPromoSchema = new mongoose.Schema({
  codigo: { type: String, unique: true, index: true, uppercase: true },
  descuentoPorcentaje: { type: Number, default: 40 },
  generadoPor: { type: String, index: true },
  tipoOrigen: { type: String, default: "post_viaje" },
  fechaCreacion: { type: Date, default: Date.now },
  fechaVencimiento: { type: Date, index: true },
  usado: { type: Boolean, default: false, index: true },
  usadoPor: String, fechaUso: Date, viajeIdAsociado: String,
}, { timestamps: true });

// ─── SESSION ─────────────────────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// ─── LISTA ESPERA ────────────────────────────────────────────────────────────
const listaEsperaSchema = new mongoose.Schema({
  userPhone: { type: String, unique: true, index: true },
  origen: { lat: Number, lng: Number, nombre: String },
  destino: { lat: Number, lng: Number, nombre: String },
  distancia: Number, precio: Number, precioPorKm: Number,
  tipoVehiculoSolicitado: { type: String, enum: ["auto", "moto", null], default: null },
  timestamp: { type: Date, default: Date.now },
  notificado: { type: Boolean, default: false },
  ofertaActivaWialonId: { type: String, default: null },
  ofertaActivaHasta: { type: Date, default: null },
  ofertasRechazadas: { type: [String], default: [] },
  ultimoMensajeAt: { type: Date, default: null },
  cancelando: { type: Boolean, default: false },
}, { timestamps: true });

// ─── RATE LIMIT ──────────────────────────────────────────────────────────────
const rateLimitSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true },
  horaStr: String,
  count: { type: Number, default: 0 },
}, { timestamps: true });

// ─── LOCATION REFERENCE (memoria de voz) ────────────────────────────────────
const locationReferenceSchema = new mongoose.Schema({
  referencia: { type: String, unique: true, index: true },
  referenciaOriginal: String,
  lat: Number, lng: Number,
  nombreResuelto: String,
  contador: { type: Number, default: 1 },
  ciudad: { type: String, default: "Cochabamba" },
}, { timestamps: true });

// ─── IA: DEMANDA POR ZONA/HORA ───────────────────────────────────────────────
const demandaSchema = new mongoose.Schema({
  zonaKey: { type: String, index: true }, // "cala_cala_18_1" (zona_hora_diasemana)
  diaSemana: Number,  // 0=Dom ... 6=Sab
  hora: Number,       // 0-23
  lat: Number, lng: Number,
  nombreZona: String,
  totalViajes: { type: Number, default: 0 },
  totalEsperaSegundos: { type: Number, default: 0 },
  ultimaActualizacion: { type: Date, default: Date.now },
}, { timestamps: true });

// ─── IA: EVENTOS DE CHOFER (para despacho inteligente) ──────────────────────
const eventoChoferSchema = new mongoose.Schema({
  choferPhone: { type: String, index: true },
  tipo: { type: String, enum: ["oferta_recibida","aceptado","rechazado","cancelado","completado","timeout"] },
  viajeId: String,
  distanciaAlOrigen: Number,  // km
  segundosParaResponder: Number,
  hora: Number, diaSemana: Number,
  zonaOrigen: String,
}, { timestamps: true });

// ─── IA: ALERTAS DE SEGURIDAD ────────────────────────────────────────────────
const alertaSegSchema = new mongoose.Schema({
  viajeId: { type: String, index: true },
  choferPhone: String, usuarioPhone: String,
  tipo: { type: String, enum: ["desvio","parada_larga","gps_apagado","zona_peligrosa","comportamiento_raro"] },
  descripcion: String,
  lat: Number, lng: Number,
  resuelta: { type: Boolean, default: false },
  notificadoAdmin: { type: Boolean, default: false },
}, { timestamps: true });

// ─── IA: PRICING SURGE ───────────────────────────────────────────────────────
const surgeSchema = new mongoose.Schema({
  fecha: { type: Date, default: Date.now },
  multiplier: Number,
  motivo: String, // "escasez_choferes", "hora_pico", "lluvia"
  viajesAfectados: Number,
}, { timestamps: true });

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const SessionState = mongoose.model("SessionState", sessionSchema, "sessionstates");
const ListaEspera = mongoose.model("ListaEspera", listaEsperaSchema, "listaesperas");
const RateLimit = mongoose.model("RateLimit", rateLimitSchema, "ratelimits");
const CodigoPromo = mongoose.model("CodigoPromo", codigoPromoSchema, "codigospromo");
const LocationReference = mongoose.model("LocationReference", locationReferenceSchema, "locationreferences");
const Demanda = mongoose.model("Demanda", demandaSchema, "demandas");
const EventoChofer = mongoose.model("EventoChofer", eventoChoferSchema, "eventoschofer");
const AlertaSeg = mongoose.model("AlertaSeg", alertaSegSchema, "alertasseg");
const Surge = mongoose.model("Surge", surgeSchema, "surges");

module.exports = {
  Usuario, Chofer, Viaje, SessionState, ListaEspera,
  RateLimit, CodigoPromo, LocationReference,
  Demanda, EventoChofer, AlertaSeg, Surge,
};
