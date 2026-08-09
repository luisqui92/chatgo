// ChatGo — Migración de datos reales: MongoDB Atlas → MySQL (Prisma)
//
// Este script NO debe correrse desde el sandbox de desarrollo: necesita acceso de
// red real a MongoDB Atlas (origen) y al MySQL destino (vía DATABASE_URL en .env,
// el contenedor MySQL de la VM nueva). Está pensado para ejecutarse UNA VEZ desde
// la VM de GCP, donde ambos accesos existen.
//
// Requiere el paquete `mongodb` (driver nativo, no Mongoose). Como se quitó de
// package.json, instalarlo puntualmente antes de correr:  npm install mongodb
//
// Uso:
//   MONGODB_URI="mongodb+srv://..." node scripts/migrar_mongo_a_mysql.js
//
// Opciones (todas opcionales, se pasan como argumentos):
//   node scripts/migrar_mongo_a_mysql.js usuarios chofers   → migra solo esas colecciones
//   node scripts/migrar_mongo_a_mysql.js --limit=50         → solo los primeros 50 docs de cada colección (smoke test)
//   node scripts/migrar_mongo_a_mysql.js --dry-run          → solo cuenta documentos, no escribe nada en MySQL
//
// Es seguro re-ejecutar: usa createMany con skipDuplicates, así que los documentos
// ya migrados (mismo id, que es el _id de Mongo) se omiten en vez de fallar.
//
// Al final imprime un resumen comparando conteos origen vs destino por colección.

const { MongoClient } = require("mongodb");
const { prisma, Usuario, Chofer, Viaje, CodigoPromo, SessionState, ListaEspera, RateLimit,
  LocationReference, Demanda, EventoChofer, AlertaSeg, Surge, ViajeDemo, EsquinaMapeada,
  PreRegistroFlota, Flota, NotificacionPago } = require("../db/models");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const SOLO = args.filter((a) => !a.startsWith("--"));

const BATCH_SIZE = 200;

// ─── TRANSFORMACIONES POR COLECCIÓN ─────────────────────────────────────────
// Cada transform() recibe el documento crudo de Mongo (driver nativo, sin Mongoose)
// y devuelve el objeto plano que Prisma espera, aplicando el mismo aplanado de
// campos (origen/destino, pagoDiario, posicion) ya hecho en prisma/schema.prisma.

const COLECCIONES = [
  {
    nombre: "usuarios",
    modelo: Usuario,
    transform: (d) => ({
      id: d._id.toString(),
      phone: d.phone,
      nombre: d.nombre ?? null,
      aceptoTerminos: !!d.aceptoTerminos,
      fechaRegistro: d.fechaRegistro ?? d.createdAt ?? new Date(),
      audioOnboardingHecho: !!d.audioOnboardingHecho,
      modoAdultoMayor: !!d.modoAdultoMayor,
      respuestasPorVoz: !!d.respuestasPorVoz,
      saldo: d.saldo ?? 0,
      familiaresVinculados: d.familiaresVinculados ?? null,
      recargas: d.recargas ?? null,
      ciudad: d.ciudad ?? null,
      ciudadDetectada: !!d.ciudadDetectada,
      viajesTotal: d.viajesTotal ?? 0,
      rutasFrecuentes: d.rutasFrecuentes ?? null,
      lugaresFrecuentes: d.lugaresFrecuentes ?? null,
      promoReactivacionEnviada: !!d.promoReactivacionEnviada,
      createdAt: d.createdAt ?? d.fechaRegistro ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "chofers",
    modelo: Chofer,
    transform: (d) => ({
      id: d._id.toString(),
      phone: d.phone,
      traccarId: d.traccarId ?? null,
      fotoChofer: d.fotoChofer ?? null,
      fotoVehiculo: d.fotoVehiculo ?? null,
      placa: d.placa ?? null,
      nombre: d.nombre ?? null,
      tipoVehiculo: d.tipoVehiculo ?? "auto",
      colorVehiculo: d.colorVehiculo ?? "",
      estado: d.estado ?? "offline",
      pagoDiarioFecha: d.pagoDiario?.fecha ?? null,
      pagoDiarioFechaStr: d.pagoDiario?.fechaStr ?? null,
      pagoDiarioPagado: !!d.pagoDiario?.pagado,
      pagoDiarioAprobado: !!d.pagoDiario?.aprobado,
      pagoDiarioComprobanteValidado: !!d.pagoDiario?.comprobanteValidado,
      viajesTotal: d.viajesTotal ?? 0,
      aceptoTerminos: !!d.aceptoTerminos,
      fechaRegistro: d.fechaRegistro ?? d.createdAt ?? new Date(),
      viajeReservado: d.viajeReservado ?? null,
      reservadoHasta: d.reservadoHasta ?? null,
      ratingPromedio: d.ratingPromedio ?? 0,
      ratingCantidad: d.ratingCantidad ?? 0,
      flota: d.flota ?? null,
      createdAt: d.createdAt ?? d.fechaRegistro ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "viajes",
    modelo: Viaje,
    transform: (d) => ({
      id: d._id.toString(),
      usuarioPhone: d.usuarioPhone ?? null,
      choferPhone: d.choferPhone ?? null,
      choferTraccarId: d.choferTraccarId ?? null,
      choferNombre: d.choferNombre ?? null,
      choferPlaca: d.choferPlaca ?? null,
      ciudad: d.ciudad ?? null,
      origenLat: d.origen?.lat ?? null,
      origenLng: d.origen?.lng ?? null,
      origenNombre: d.origen?.nombre ?? null,
      destinoLat: d.destino?.lat ?? null,
      destinoLng: d.destino?.lng ?? null,
      destinoNombre: d.destino?.nombre ?? null,
      paradas: d.paradas ?? null,
      observaciones: d.observaciones ?? null,
      distanciaKm: d.distanciaKm ?? null,
      precioBase: d.precioBase ?? null,
      descuentoBs: d.descuentoBs ?? 0,
      codigoPromoUsado: d.codigoPromoUsado ?? null,
      precioTotal: d.precioTotal ?? null,
      precioPorKm: d.precioPorKm ?? null,
      tipoVehiculo: d.tipoVehiculo ?? "auto",
      estado: d.estado ?? "pendiente",
      fechaInicio: d.fechaInicio ?? d.createdAt ?? new Date(),
      fechaAsignacion: d.fechaAsignacion ?? null,
      fechaAceptacion: d.fechaAceptacion ?? null,
      fechaInicioViaje: d.fechaInicioViaje ?? null,
      tiempoEstimadoMin: d.tiempoEstimadoMin ?? null,
      fechaFin: d.fechaFin ?? null,
      llegadaNotificada: !!d.llegadaNotificada,
      llegadaOrigenNotificada: !!d.llegadaOrigenNotificada,
      cancelacionMotivo: d.cancelacionMotivo ?? null,
      ratingPasajero: d.ratingPasajero ?? null,
      comentarioPasajero: d.comentarioPasajero ?? null,
      ratingSolicitado: !!d.ratingSolicitado,
      codigoPromoGenerado: d.codigoPromoGenerado ?? null,
      rutaPolilinea: d.rutaPolilinea ?? null,
      rutaPuntos: d.rutaPuntos ?? null,
      nivelAlerta: d.nivelAlerta ?? "verde",
      eventosSeguridad: d.eventosSeguridad ?? null,
      detenidoDesde: d.detenidoDesde ?? null,
      ultimaPosicionLat: d.ultimaPosicionLat ?? null,
      ultimaPosicionLng: d.ultimaPosicionLng ?? null,
      ultimaPosicionAt: d.ultimaPosicionAt ?? null,
      panicoActivado: !!d.panicoActivado,
      panicoAt: d.panicoAt ?? null,
      extendidoPorTrafico: !!d.extendidoPorTrafico,
      createdAt: d.createdAt ?? d.fechaInicio ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "codigospromo",
    modelo: CodigoPromo,
    transform: (d) => ({
      id: d._id.toString(),
      codigo: d.codigo,
      descuentoPorcentaje: d.descuentoPorcentaje ?? 40,
      generadoPor: d.generadoPor ?? null,
      tipoOrigen: d.tipoOrigen ?? "post_viaje",
      fechaCreacion: d.fechaCreacion ?? d.createdAt ?? new Date(),
      fechaVencimiento: d.fechaVencimiento ?? null,
      usado: !!d.usado,
      usadoPor: d.usadoPor ?? null,
      fechaUso: d.fechaUso ?? null,
      viajeIdAsociado: d.viajeIdAsociado ?? null,
      createdAt: d.createdAt ?? d.fechaCreacion ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "sessionstates",
    modelo: SessionState,
    transform: (d) => ({
      id: d._id.toString(),
      phone: d.phone,
      data: d.data ?? {},
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "listaesperas",
    modelo: ListaEspera,
    transform: (d) => ({
      id: d._id.toString(),
      userPhone: d.userPhone,
      ciudad: d.ciudad ?? null,
      origenLat: d.origen?.lat ?? null,
      origenLng: d.origen?.lng ?? null,
      origenNombre: d.origen?.nombre ?? null,
      destinoLat: d.destino?.lat ?? null,
      destinoLng: d.destino?.lng ?? null,
      destinoNombre: d.destino?.nombre ?? null,
      distancia: d.distancia ?? null,
      precio: d.precio ?? null,
      precioPorKm: d.precioPorKm ?? null,
      tipoVehiculoSolicitado: d.tipoVehiculoSolicitado ?? null,
      timestamp: d.timestamp ?? d.createdAt ?? new Date(),
      notificado: !!d.notificado,
      ofertaActivaChoferId: d.ofertaActivaWialonId ?? d.ofertaActivaChoferId ?? null,
      ofertaActivaHasta: d.ofertaActivaHasta ?? null,
      ofertasRechazadas: d.ofertasRechazadas ?? null,
      ultimoMensajeAt: d.ultimoMensajeAt ?? null,
      cancelando: !!d.cancelando,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "ratelimits",
    modelo: RateLimit,
    transform: (d) => ({
      id: d._id.toString(),
      phone: d.phone,
      horaStr: d.horaStr ?? null,
      count: d.count ?? 0,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "locationreferences",
    modelo: LocationReference,
    transform: (d) => ({
      id: d._id.toString(),
      referencia: d.referencia,
      referenciaOriginal: d.referenciaOriginal ?? null,
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      nombreResuelto: d.nombreResuelto ?? null,
      contador: d.contador ?? 1,
      ciudad: d.ciudad ?? "Cochabamba",
      precargado: !!d.precargado,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "demandas",
    modelo: Demanda,
    transform: (d) => ({
      id: d._id.toString(),
      zona: d.zona ?? "desconocida",
      hora: d.hora ?? 0,
      diaSemana: d.diaSemana ?? 0,
      cantidad: d.cantidad ?? 1,
      ultimaActualizacion: d.ultimaActualizacion ?? new Date(),
    }),
  },
  {
    nombre: "eventochofers",
    modelo: EventoChofer,
    transform: (d) => ({
      id: d._id.toString(),
      choferPhone: d.choferPhone,
      tipo: d.tipo ?? null,
      viajeId: d.viajeId ? d.viajeId.toString() : null,
      zona: d.zona ?? null,
      tiempoRespuesta: d.tiempoRespuesta ?? null,
      timestamp: d.timestamp ?? new Date(),
    }),
  },
  {
    nombre: "alertasegs",
    modelo: AlertaSeg,
    transform: (d) => ({
      id: d._id.toString(),
      viajeId: d.viajeId ? d.viajeId.toString() : null,
      tipo: d.tipo ?? null,
      descripcion: d.descripcion ?? null,
      posicionLat: d.posicion?.lat ?? null,
      posicionLng: d.posicion?.lng ?? null,
      notificadoPasajero: !!d.notificadoPasajero,
      notificadoAdmin: !!d.notificadoAdmin,
      timestamp: d.timestamp ?? new Date(),
    }),
  },
  {
    nombre: "surges",
    modelo: Surge,
    transform: (d) => ({
      id: d._id.toString(),
      zona: d.zona ?? "general",
      multiplier: d.multiplier ?? 1.0,
      motivo: d.motivo ?? null,
      viajesAfectados: d.viajesAfectados ?? 0,
      vigenteHasta: d.vigenteHasta ?? null,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "viajedemos",
    modelo: ViajeDemo,
    transform: (d) => ({
      id: d._id.toString(),
      diaId: d.diaId,
      choferIdx: d.choferIdx ?? null,
      choferNombre: d.choferNombre ?? null,
      choferPlaca: d.choferPlaca ?? null,
      choferTipo: d.choferTipo ?? null,
      usuarioNombre: d.usuarioNombre ?? null,
      usuarioPhone: d.usuarioPhone ?? null,
      origenNombre: d.origen?.nombre ?? null,
      origenLat: d.origen?.lat ?? null,
      origenLng: d.origen?.lng ?? null,
      destinoNombre: d.destino?.nombre ?? null,
      destinoLat: d.destino?.lat ?? null,
      destinoLng: d.destino?.lng ?? null,
      distanciaKm: d.distanciaKm ?? null,
      precioTotal: d.precioTotal ?? null,
      estado: d.estado ?? null,
      rating: d.rating ?? null,
      tInicio: d.tInicio ?? null,
      tAceptado: d.tAceptado ?? null,
      tLlegoOrigen: d.tLlegoOrigen ?? null,
      tSubioPasajero: d.tSubioPasajero ?? null,
      tCompletado: d.tCompletado ?? null,
      choferPosLat: d.choferPosLat ?? null,
      choferPosLng: d.choferPosLng ?? null,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "esquinamapeadas",
    modelo: EsquinaMapeada,
    transform: (d) => ({
      id: d._id.toString(),
      llave: d.llave,
      calle1: d.calle1 ?? null,
      calle2: d.calle2 ?? null,
      zona: d.zona ?? null,
      ciudad: d.ciudad ?? "Cochabamba",
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      usos: d.usos ?? 1,
      primerUsuario: d.primerUsuario ?? null,
      ultimoUso: d.ultimoUso ?? new Date(),
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "preregistroflotas",
    modelo: PreRegistroFlota,
    transform: (d) => ({
      id: d._id.toString(),
      phone: d.phone,
      flota: d.flota,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "flotas",
    modelo: Flota,
    transform: (d) => ({
      id: d._id.toString(),
      codigo: d.codigo,
      nombre: d.nombre,
      token: d.token,
      activa: d.activa !== false,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
  {
    nombre: "notificacionespago",
    modelo: NotificacionPago,
    transform: (d) => ({
      id: d._id.toString(),
      texto: d.texto ?? null,
      monto: d.monto ?? null,
      usado: !!d.usado,
      createdAt: d.createdAt ?? new Date(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(),
    }),
  },
];

// ─── MIGRACIÓN DE UNA COLECCIÓN ─────────────────────────────────────────────
async function migrarColeccion(mongoDb, { nombre, modelo, transform }) {
  const collection = mongoDb.collection(nombre);
  const totalOrigen = await collection.countDocuments();
  console.log(`\n📦 ${nombre}: ${totalOrigen} documento(s) en MongoDB`);

  if (totalOrigen === 0) return { nombre, totalOrigen, migrados: 0, fallidos: 0 };
  if (DRY_RUN) return { nombre, totalOrigen, migrados: 0, fallidos: 0 };

  let cursor = collection.find({});
  if (LIMIT) cursor = cursor.limit(LIMIT);

  let migrados = 0;
  let fallidos = 0;
  let batch = [];

  async function volcarBatch() {
    if (batch.length === 0) return;
    try {
      const r = await modelo.createMany({ data: batch, skipDuplicates: true });
      migrados += r.count;
    } catch (e) {
      // Algo en el batch no encaja (tipo de dato, valor inesperado) — reintentar
      // documento por documento para no perder el resto del batch y poder señalar
      // exactamente cuál falló.
      console.warn(`   ⚠️ Falló el batch completo (${e.message}), reintentando 1 por 1...`);
      for (const doc of batch) {
        try {
          await modelo.create({ data: doc });
          migrados++;
        } catch (e2) {
          fallidos++;
          console.error(`   ❌ ${nombre} id=${doc.id}: ${e2.message}`);
        }
      }
    }
    batch = [];
  }

  for await (const raw of cursor) {
    try {
      batch.push(transform(raw));
    } catch (e) {
      fallidos++;
      console.error(`   ❌ ${nombre} id=${raw._id}: error transformando — ${e.message}`);
      continue;
    }
    if (batch.length >= BATCH_SIZE) await volcarBatch();
  }
  await volcarBatch();

  console.log(`   ✅ migrados: ${migrados}  ❌ fallidos: ${fallidos}`);
  return { nombre, totalOrigen, migrados, fallidos };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("❌ Falta la variable de entorno MONGODB_URI (string de conexión a Atlas).");
    console.error('   Uso: MONGODB_URI="mongodb+srv://..." node scripts/migrar_mongo_a_mysql.js');
    process.exit(1);
  }

  console.log(`🔌 Conectando a MongoDB Atlas...`);
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const mongoDb = client.db();
  console.log(`✅ Conectado a MongoDB: ${mongoDb.databaseName}`);

  if (DRY_RUN) console.log("🧪 Modo --dry-run: solo se van a contar documentos, no se escribe nada en MySQL.\n");
  if (LIMIT) console.log(`🔢 Límite por colección: ${LIMIT} documento(s).\n`);

  const objetivos = SOLO.length > 0 ? COLECCIONES.filter((c) => SOLO.includes(c.nombre)) : COLECCIONES;
  if (objetivos.length === 0) {
    console.error(`❌ Ninguna colección coincide con: ${SOLO.join(", ")}`);
    console.error(`   Colecciones válidas: ${COLECCIONES.map((c) => c.nombre).join(", ")}`);
    process.exit(1);
  }

  const resultados = [];
  for (const objetivo of objetivos) {
    resultados.push(await migrarColeccion(mongoDb, objetivo));
  }

  await client.close();

  console.log("\n" + "─".repeat(60));
  console.log("RESUMEN");
  console.log("─".repeat(60));
  let totalFallidos = 0;
  for (const r of resultados) {
    const destinoCol = COLECCIONES.find((c) => c.nombre === r.nombre).modelo;
    const totalDestino = DRY_RUN ? "—" : await destinoCol.count();
    console.log(
      `${r.nombre.padEnd(20)} origen=${String(r.totalOrigen).padEnd(8)} destino=${String(totalDestino).padEnd(8)} fallidos=${r.fallidos}`
    );
    totalFallidos += r.fallidos;
  }
  console.log("─".repeat(60));
  if (totalFallidos > 0) {
    console.log(`⚠️ Hubo ${totalFallidos} documento(s) que no se pudieron migrar. Revisa los errores arriba.`);
  } else {
    console.log("✅ Migración completa sin errores.");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Error fatal en la migración:", e);
  process.exit(1);
});
