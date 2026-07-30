// ChatGo — Modelos (MySQL vía Prisma)
// NOTA MIGRACIÓN: este archivo exportaba antes los modelos Mongoose directamente.
// Ahora exporta los delegates de Prisma con los mismos nombres (Usuario, Chofer, etc.)
// para no tener que cambiar los imports en el resto del código — pero la API de cada
// uno cambia de Mongoose a Prisma (ver db/prisma.js y prisma/schema.prisma).
const prisma = require("./prisma");

module.exports = {
  prisma,
  Usuario: prisma.usuario,
  Chofer: prisma.chofer,
  Viaje: prisma.viaje,
  SessionState: prisma.sessionState,
  ListaEspera: prisma.listaEspera,
  RateLimit: prisma.rateLimit,
  CodigoPromo: prisma.codigoPromo,
  LocationReference: prisma.locationReference,
  Demanda: prisma.demanda,
  EventoChofer: prisma.eventoChofer,
  AlertaSeg: prisma.alertaSeg,
  Surge: prisma.surge,
  ViajeDemo: prisma.viajeDemo,
  EsquinaMapeada: prisma.esquinaMapeada,
  PreRegistroFlota: prisma.preRegistroFlota,
  Flota: prisma.flota,
  NotificacionPago: prisma.notificacionPago,
  Solicitud: prisma.solicitud,
  Restaurante: prisma.restaurante,
  Plato: prisma.plato,
  Mecanico: prisma.mecanico,
  Auxilio: prisma.auxilio,
  PedidoAgua: prisma.pedidoAgua,
  Vendedor: prisma.vendedor,
  EvaluacionVenta: prisma.evaluacionVenta,
  LineaVentas: prisma.lineaVentas,
  ChatVentas: prisma.chatVentas,
};
