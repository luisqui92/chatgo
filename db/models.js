// ChatGo — Schemas MongoDB
const mongoose = require("mongoose");
const os = require("os");
const { CONFIG, log } = require("../config");

mongoose.connect(CONFIG.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000, // fallar rápido en vez de esperar el default de 30s
  connectTimeoutMS: 5000,
  socketTimeoutMS: 20000,
  maxPoolSize: 20,
  minPoolSize: 5,
}).then(
  () => log.info("✅ MongoDB conectado"),
  (e) => log.error("❌ MongoDB:", e.message)
);

mongoose.connection.on("disconnected", () => log.warn("⚠️ MongoDB desconectado, reintentando..."));
mongoose.connection.on("reconnected", () => log.info("✅ MongoDB reconectado"));

const usuarioSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    nombre: String,
    aceptoTerminos: { type: Boolean, default: false },
    fechaRegistro: { type: Date, default: Date.now },
    audioOnboardingHecho: { type: Boolean, default: false },
    // ─── MODO ADULTO MAYOR + BILLETERA FAMILIAR ───────────────────────────
    modoAdultoMayor: { type: Boolean, default: false }, // si está activo, las respuestas son por voz (TTS)
    respuestasPorVoz: { type: Boolean, default: false }, // preferencia de recibir respuestas en audio
    saldo: { type: Number, default: 0 },                 // saldo en Bs precargado por la familia
    // Familiares autorizados a gestionar esta cuenta (recargar, guardar lugares)
    familiaresVinculados: [{
      phone: String,            // WhatsApp del familiar
      nombre: String,           // "hija", "hijo", "nieto"
      fechaVinculo: { type: Date, default: Date.now },
    }],
    // Historial de recargas para trazabilidad
    recargas: [{
      monto: Number,
      familiarPhone: String,
      fecha: { type: Date, default: Date.now },
      comprobante: String,      // mediaId del comprobante si aplica
    }],
  ciudad: { type: String, default: null }, // "Cochabamba", "La Paz", "Santa Cruz", etc.
  ciudadDetectada: { type: Boolean, default: false }, // si fue detectada automáticamente
    viajesTotal: { type: Number, default: 0 },
    rutasFrecuentes: [
      {
        origen: { lat: Number, lng: Number, nombre: String },
        destino: { lat: Number, lng: Number, nombre: String },
        contador: { type: Number, default: 1 },
        // Copiloto de hábitos: franjas horarias en que se hace este viaje (0-23)
        // Guardamos cuántas veces se viajó en cada hora para detectar patrones
        horas: { type: [Number], default: [] },        // ej: [8, 8, 8, 18] = 3 veces a las 8am, 1 a las 6pm
        tipoVehiculo: { type: String, default: "auto" }, // último tipo usado en esta ruta
        ultimoViaje: { type: Date, default: Date.now },
      },
    ],
    // Lugares personales guardados (casa, trabajo, etc.)
    lugaresFrecuentes: {
      casa: { lat: Number, lng: Number, nombre: String },
      trabajo: { lat: Number, lng: Number, nombre: String },
      // Otros lugares personalizados (mama, gym, etc.)
      otros: [
        {
          alias: String, // "mamá", "gimnasio", "iglesia"
          lat: Number,
          lng: Number,
          nombre: String,
        },
      ],
    },
  },
  { timestamps: true }
);

const choferSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, index: true },
    wialonId: { type: String, unique: true, sparse: true, index: true },
    traccarId: { type: String, unique: true, sparse: true, index: true },
    fotoChofer: { type: String },
    fotoVehiculo: { type: String },
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
    flota: { type: String, default: null, index: true }, // radiotaxi/empresa a la que pertenece (null = independiente)
  },
  { timestamps: true }
);

const viajeSchema = new mongoose.Schema(
  {
    usuarioPhone: { type: String, index: true },
    choferPhone: { type: String, index: true },
    choferWialonId: { type: String, index: true },
    choferTraccarId: { type: String, index: true },
    choferNombre: String,
    choferPlaca: String,
    ciudad: { type: String, default: null, index: true }, // calculada del origen al crear el viaje
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
    fechaInicioViaje: Date,
    tiempoEstimadoMin: Number,
    fechaFin: Date,
    llegadaNotificada: { type: Boolean, default: false },
    llegadaOrigenNotificada: { type: Boolean, default: false },
    cancelacionMotivo: String,
    ratingPasajero: Number,
    comentarioPasajero: String,
    ratingSolicitado: { type: Boolean, default: false },
    codigoPromoGenerado: String,
    // ─── COPILOTO IA: ruta y monitoreo de seguridad ───────────────────────
    rutaPolilinea: { type: String, default: null },      // polyline codificada de Google (overview_polyline)
    rutaPuntos: [{ lat: Number, lng: Number }],          // puntos decodificados para cálculo de desvío
    nivelAlerta: { type: String, enum: ["verde", "amarillo", "naranja", "rojo"], default: "verde", index: true },
    eventosSeguridad: [{
      tipo: String,        // desvio | retraso | detenido | velocidad_anormal | panico | zona_aislada
      nivel: String,       // amarillo | naranja | rojo
      detalle: String,
      lat: Number,
      lng: Number,
      timestamp: { type: Date, default: Date.now },
    }],
    detenidoDesde: { type: Date, default: null },         // cuándo empezó a estar detenido (para timeout)
    ultimaPosicionLat: Number,
    ultimaPosicionLng: Number,
    ultimaPosicionAt: Date,
    panicoActivado: { type: Boolean, default: false },
    panicoAt: Date,
    extendidoPorTrafico: { type: Boolean, default: false },
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
    ciudad: { type: String, default: null, index: true }, // calculada del origen al crear/actualizar el pedido
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
    referencia: { type: String, index: true }, // normalizada (única POR CIUDAD, ver índice compuesto abajo)
    referenciaOriginal: String,
    lat: Number,
    lng: Number,
    nombreResuelto: String,
    contador: { type: Number, default: 1 },
    ciudad: { type: String, default: "Cochabamba" },
    precargado: { type: Boolean, default: false }, // true si vino del script de pre-carga
  },
  { timestamps: true }
);
// Único por combinación referencia+ciudad: la misma referencia puede existir en
// distintas ciudades (ej "avenida piraí" en Cochabamba y en Santa Cruz).
locationReferenceSchema.index({ referencia: 1, ciudad: 1 }, { unique: true });

const Usuario = mongoose.model("Usuario", usuarioSchema);
const Chofer = mongoose.model("Chofer", choferSchema);
const Viaje = mongoose.model("Viaje", viajeSchema);
const SessionState = mongoose.model("SessionState", sessionSchema, "sessionstates");
const ListaEspera = mongoose.model("ListaEspera", listaEsperaSchema, "listaesperas");
const RateLimit = mongoose.model("RateLimit", rateLimitSchema, "ratelimits");
const CodigoPromo = mongoose.model("CodigoPromo", codigoPromoSchema, "codigospromo");
const LocationReference = mongoose.model("LocationReference", locationReferenceSchema, "locationreferences");


// ─── NUEVOS MODELOS PARA IA ─────────────────────────────────────────────────
const demandaSchema = new mongoose.Schema({
  zona: { type: String, required: true },
  hora: { type: Number, required: true },
  diaSemana: { type: Number, required: true },
  cantidad: { type: Number, default: 1 },
  ultimaActualizacion: { type: Date, default: Date.now },
});
demandaSchema.index({ zona: 1, hora: 1, diaSemana: 1 });
const Demanda = mongoose.model("Demanda", demandaSchema);

const eventoChoferSchema = new mongoose.Schema({
  choferPhone: { type: String, required: true, index: true },
  tipo: { type: String, enum: ["aceptado","rechazado","cancelado","completado","timeout"] },
  viajeId: { type: mongoose.Schema.Types.ObjectId, ref: "Viaje" },
  zona: String,
  tiempoRespuesta: Number,
  timestamp: { type: Date, default: Date.now, index: true },
});
const EventoChofer = mongoose.model("EventoChofer", eventoChoferSchema);

const alertaSegSchema = new mongoose.Schema({
  viajeId: { type: mongoose.Schema.Types.ObjectId, ref: "Viaje", index: true },
  tipo: { type: String, enum: ["desvio","tiempo_excesivo","parada_sospechosa","trafico","gps_perdido","velocidad_anormal"] },
  descripcion: String,
  posicion: { lat: Number, lng: Number },
  notificadoPasajero: { type: Boolean, default: false },
  notificadoAdmin: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});
const AlertaSeg = mongoose.model("AlertaSeg", alertaSegSchema);

// Schema unificado: soporta registro histórico (pricing.js) y surge activo por zona
const surgeSchema = new mongoose.Schema({
  zona: { type: String, default: "general" },
  multiplier: { type: Number, default: 1.0 },
  motivo: String,
  viajesAfectados: { type: Number, default: 0 },
  vigenteHasta: { type: Date, default: null },
}, { timestamps: true });
surgeSchema.index({ zona: 1, vigenteHasta: 1 });
const Surge = mongoose.model("Surge", surgeSchema, "surges");

// ─── ÍNDICES COMPUESTOS PARA RENDIMIENTO ─────────────────────────────────────
viajeSchema.index({ estado: 1, fechaAsignacion: 1 });
viajeSchema.index({ usuarioPhone: 1, estado: 1 });
viajeSchema.index({ choferPhone: 1, estado: 1 });
listaEsperaSchema.index({ timestamp: 1 });
listaEsperaSchema.index({ ofertaActivaWialonId: 1, timestamp: 1 });



// ─── MODELO DEMO (no toca datos reales) ─────────────────────────────────────
const viajeDemoSchema = new mongoose.Schema({
  diaId: { type: Number, required: true, index: true }, // YYYYMMDD del día (4am reset)
  choferIdx: Number,           // índice del chofer en la lista
  choferNombre: String,
  choferPlaca: String,
  choferTipo: String,
  usuarioNombre: String,
  usuarioPhone: String,
  origen: { nombre: String, lat: Number, lng: Number },
  destino: { nombre: String, lat: Number, lng: Number },
  distanciaKm: Number,
  precioTotal: Number,
  estado: { type: String, index: true },
  rating: Number,
  // Tiempos del ciclo
  tInicio: Number,        // ms cuando se creó
  tAceptado: Number,      // ms cuando chofer aceptó
  tLlegoOrigen: Number,
  tSubioPasajero: Number,
  tCompletado: Number,
  // Posición simulada del chofer (se actualiza con cada tick)
  choferPosLat: Number,
  choferPosLng: Number,
}, { timestamps: true });
viajeDemoSchema.index({ diaId: 1, estado: 1 });
const ViajeDemo = mongoose.model("ViajeDemo", viajeDemoSchema);



// ─── ESQUINAS MAPEADAS (memoria compartida — crowdsourcing) ─────────────────
// Cuando un usuario mapea una esquina como "Ayacucho y Sucre", se guarda acá
// para que cualquier otro usuario que la mencione la encuentre sin pedir pin
const esquinaMapeadaSchema = new mongoose.Schema({
  // Llave normalizada: dos nombres de calles ordenados alfabéticamente, sin tildes, lowercase
  // Ej: "Ayacucho y Sucre" → "ayacucho|sucre"
  llave: { type: String, unique: true, index: true, required: true },
  calle1: String,
  calle2: String,
  zona: String, // "Centro Cochabamba", "Sacaba", "Quillacollo", etc.
  ciudad: { type: String, default: "Cochabamba" },
  lat: Number,
  lng: Number,
  usos: { type: Number, default: 1 }, // cuántas veces se usó esta esquina
  primerUsuario: String,
  ultimoUso: { type: Date, default: Date.now },
}, { timestamps: true });
const EsquinaMapeada = mongoose.model("EsquinaMapeada", esquinaMapeadaSchema);

// Pre-registro de flota: cuando un chofer pone su código de radiotaxi ANTES de
// registrarse, lo guardamos acá (teléfono → flota). Al aprobarse el chofer, se le
// aplica la flota automáticamente. Así el código no se pierde entre los dos momentos.
const preRegistroFlotaSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true, required: true },
  flota: { type: String, required: true },
}, { timestamps: true });
const PreRegistroFlota = mongoose.model("PreRegistroFlota", preRegistroFlotaSchema);

// Flotas de radiotaxi aliadas. Cada empresa tiene un código (para el link de registro),
// un nombre visible, y un token secreto (para que su dueño vea su panel /admin/flota-data).
// Agregar una flota nueva = insertar un documento acá (sin tocar código ni variables).
const flotaSchema = new mongoose.Schema({
  codigo: { type: String, unique: true, index: true, required: true, lowercase: true, trim: true }, // ej: "clasico"
  nombre: { type: String, required: true },     // ej: "Radio Taxi Clásico"
  token: { type: String, unique: true, required: true },  // secreto para el panel del dueño
  activa: { type: Boolean, default: true },
}, { timestamps: true });
const Flota = mongoose.model("Flota", flotaSchema, "flotas");

// Notificaciones bancarias (Yape vía MacroDroid) que llegaron sin ningún chofer
// pendiente de aprobación todavía — pasa cuando la notificación llega antes de que
// el chofer mande la foto del comprobante. Se guardan un rato para poder matchearlas
// apenas se valide el comprobante correspondiente. TTL: se autoborran a los 20 min.
const notificacionPagoSchema = new mongoose.Schema({
  texto: String,
  monto: Number,
  usado: { type: Boolean, default: false, index: true },
}, { timestamps: true });
notificacionPagoSchema.index({ createdAt: 1 }, { expireAfterSeconds: 1200 });
const NotificacionPago = mongoose.model("NotificacionPago", notificacionPagoSchema, "notificacionespago");


// ─── MÓDULO CONSULTAS MÉDICAS ────────────────────────────────────────────────
// Médico que sube consultas para transcribir. Login con teléfono + contraseña;
// solo médicos ya registrados/activos pueden entrar. Mismo cluster/conexión
// que el resto de chatgo (misma base de datos, colecciones separadas).
const medicoSchema = new mongoose.Schema({
  phone: { type: String, unique: true, index: true, required: true },
  nombre: { type: String, required: true },
  especialidad: { type: String, default: "" },
  passwordHash: { type: String, required: true },
  activo: { type: Boolean, default: true },
}, { timestamps: true });
const Medico = mongoose.model("Medico", medicoSchema);

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
const ConsultaMedica = mongoose.model("ConsultaMedica", consultaMedicaSchema);

module.exports = { Usuario, Chofer, Viaje, SessionState, ListaEspera, RateLimit, CodigoPromo, LocationReference, Demanda, EventoChofer, AlertaSeg, Surge, ViajeDemo, EsquinaMapeada, PreRegistroFlota, Flota, NotificacionPago, Medico, ConsultaMedica };
