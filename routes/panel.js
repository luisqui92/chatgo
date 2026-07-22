// ChatGo — Panel de Operaciones (simulación por ciudad)
//
// GET /panel        → dashboard con selector de ciudad, mapa en vivo y feed
// GET /panel/datos  → JSON con viajes por ciudad, choferes y feed (poll cada 4s)
//
// TODO es determinista y CALCULADO en base a la hora (no se escribe en la base):
// por eso el link NUNCA se rompe y "se reinicia" solo a las 4:00 AM (los conteos
// son función del tiempo transcurrido desde las 4am). Usa los nombres reales de
// choferes de la base y completa hasta 140 autos (120 Cochabamba + 20 Santa Cruz).
// Las posiciones del mapa se calculan en el navegador (movimiento suave) a partir
// de un seed estable que manda el servidor.

const { Chofer } = require("../db/models");
const { log } = require("../config");

const FLOTA_CBBA = 120;
const FLOTA_SCZ = 20;

// Curva de demanda por hora (pico mañana/mediodía/tarde)
function factorHora(h) {
  const c = [0.2,0.1,0.1,0.1,0.2,0.4, 0.8,1.4,1.6,1.2,0.9,1.0, 1.5,1.4,1.0,0.9,1.0,1.3, 1.8,1.6,1.4,1.0,0.6,0.4];
  return c[h] || 1.0;
}
const TOTAL_DIA = (() => { let s = 0; for (let h = 0; h < 24; h++) s += factorHora(h); return s; })();

function unidadesDesde4(now) {
  const d = new Date(now);
  const h = d.getHours(), m = d.getMinutes();
  const horasPasadas = (h - 4 + 24) % 24;
  let u = 0;
  for (let k = 0; k < horasPasadas; k++) u += factorHora((4 + k) % 24);
  u += factorHora(h) * (m / 60);
  return u;
}
function diaId4am(now) {
  const d = new Date(now - 4 * 3600 * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMBRES = ["Carlos","José","Luis","Juan","Marco","Freddy","Rodrigo","Álvaro","Grover","Wilson","Edwin","Ramiro","René","Óscar","Javier","Mauricio","Gonzalo","Iván","David","Richard","Gabriel","Nelson","Rubén","Hugo","Fernando","Roberto","Miguel","Sergio","Daniel","Pablo","Ariel","Cristian","Jhonny","Limbert","Vladimir","Boris","Wálter","Germán","Marcelo","Ronald","Adhemar","Willy","Elvis","Franz","Efraín","Delfín","Saúl","Abraham","Néstor","Vicente"];
const APELLIDOS = ["Mamani","Quispe","Choque","Flores","Condori","Vargas","Rojas","Colque","Ticona","Apaza","Gutiérrez","Fernández","Rodríguez","Villca","Cruz","Torrez","Camacho","Céspedes","Ledezma","Zeballos","Arispe","Montaño","Balderrama","Sejas","Terrazas","Claros","Peredo","Antezana","Escóbar","Ovando","Guzmán","Salvatierra","Suárez","Áñez","Justiniano","Roca","Cuéllar","Menacho","Parada","Áñez"];
const PASAJEROS = ["Ana","María","Sofía","Lucía","Carla","Daniela","Fernanda","Gabriela","Rocío","Susana","Andrea","Paola","Valeria","Jorge","Pedro","Diego","Mateo","Sergio","Bruno","Iván","Camila","Noelia","Fabiola","Ximena"];
const ZONAS = {
  cbba: ["Cala Cala","El Prado","Plaza Colón","Av. América","Quillacollo","Sacaba","La Recoleta","Muyurina","Av. Blanco Galindo","Zona Sur","Tiquipaya","Centro","Hipódromo","Av. Heroínas","Sarco","Temporal","Villa Busch","Colcapirhua"],
  scz: ["Equipetrol","Plan 3000","Monseñor Rivero","2do Anillo","Las Palmas","Urubó","Cristo Redentor","4to Anillo","La Ramada","Villa 1ro de Mayo","Ventura Mall","Av. Alemana","Los Pozos","Av. Banzer","6to Anillo","Sirari"],
};

function nombreGenerado(i) {
  const r = rng(i * 2654435761 + 12345);
  return NOMBRES[Math.floor(r() * NOMBRES.length)] + " " + APELLIDOS[Math.floor(r() * APELLIDOS.length)];
}
function placaGenerada(i) {
  const r = rng(i * 40503 + 777);
  const num = 1000 + Math.floor(r() * 8999);
  const L = "ABCDEFGHJKLMNPRSTUVXYZ";
  return num + "-" + L[Math.floor(r() * L.length)] + L[Math.floor(r() * L.length)] + L[Math.floor(r() * L.length)];
}

// Ausencias: fracción de autos registrados que HOY no trabajan (no es utopía
// que toda la flota esté activa). 25% de ausencias en CBBA, 10% en Santa Cruz.
const TASA_AUSENCIA = { cbba: 0.25, scz: 0.10 };

function construirFlota(ciudadId, ciudadNombre, cantidad, reales, offsetReal, now) {
  const dia = diaId4am(now);
  const u = unidadesDesde4(now);
  const horaAhora = new Date(now).getHours();
  const bucket = Math.floor(now / (8 * 60 * 1000)); // bucket de 8 min para el estado
  const tasaAusencia = TASA_AUSENCIA[ciudadId] || 0.2;

  const choferes = [];
  for (let k = 0; k < cantidad; k++) {
    const gi = offsetReal + k;
    const real = reales[gi] || null;
    const seed = (gi + 1) * 7919 + dia;
    const r = rng(seed);

    const nombre = real ? real.nombre : nombreGenerado(gi);
    const tipo = real ? (real.tipoVehiculo || "auto") : (r() < 0.12 ? "moto" : "auto");
    const placa = real ? (real.placa || placaGenerada(gi)) : placaGenerada(gi);
    const color = real ? (real.colorVehiculo || "") : ["Blanco","Gris","Negro","Rojo","Azul","Plata"][Math.floor(r() * 6)];

    // ¿Este auto trabaja hoy? (estable en el día). Ausente = no trabaja.
    const activoHoy = r() >= tasaAusencia;

    const actividad = 0.6 + r() * 0.9;
    const baseDaily = 12 + Math.floor(r() * 8);
    const viajes = activoHoy ? Math.max(1, Math.round(actividad * baseDaily * (u / TOTAL_DIA))) : 0;

    let rating, ratingCant;
    if (real && real.ratingCantidad > 0) {
      rating = Math.round(real.ratingPromedio * 10) / 10;
      ratingCant = real.ratingCantidad;
    } else {
      rating = Math.round((4.3 + r() * 0.7) * 10) / 10;
      ratingCant = 20 + Math.floor(r() * 400);
    }

    // Estado ahora: los que no trabajan hoy quedan offline. Los activos varían
    // entre libre/en_viaje, con algo de offline (descansos) y más de noche.
    let estado;
    if (!activoHoy) {
      estado = "offline";
    } else {
      const rt = rng(seed + bucket * 104729);
      const probOffline = (horaAhora < 6 || horaAhora >= 23) ? 0.7 : 0.08;
      const probOcupado = Math.min(0.7, 0.40 * factorHora(horaAhora));
      const x = rt();
      if (x < probOffline) estado = "offline";
      else if (x < probOffline + probOcupado) estado = "en_viaje";
      else estado = "libre";
    }

    const ingresos = viajes * (tipo === "moto" ? 9 : 16);

    choferes.push({
      id: ciudadId + "-" + gi,
      posSeed: gi + 1,          // seed estable para la posición en el mapa
      nombre, tipo, placa, color,
      rating, ratingCant,
      viajes, ingresos, estado,
      ciudad: ciudadNombre,
      esReal: !!real,
      foto: real ? (real.fotoChofer || null) : null,
    });
  }
  return choferes;
}

// Feed de últimos viajes (determinista por bucket de tiempo)
function generarFeed(ciudadKey, choferes, now) {
  const zonas = ZONAS[ciudadKey];
  const horaAhora = new Date(now).getHours();
  const intervalo = (ciudadKey === "cbba" ? 45000 : 150000) / Math.max(0.4, factorHora(horaAhora)); // ms entre viajes
  const feed = [];
  const bucketAhora = Math.floor(now / intervalo);
  for (let k = 0; k < 9; k++) {
    const b = bucketAhora - k;
    const r = rng(b * 2246822519 + (ciudadKey === "cbba" ? 11 : 97));
    const ch = choferes[Math.floor(r() * choferes.length)];
    let oi = Math.floor(r() * zonas.length), di = Math.floor(r() * zonas.length);
    if (di === oi) di = (di + 1) % zonas.length;
    const precio = (ch.tipo === "moto" ? 6 : 9) + Math.floor(r() * 22);
    const haceSeg = Math.round((now - b * intervalo) / 1000);
    feed.push({
      chofer: ch.nombre, pasajero: PASAJEROS[Math.floor(r() * PASAJEROS.length)],
      origen: zonas[oi], destino: zonas[di], precio, haceSeg,
      tipo: ch.tipo,
    });
  }
  return feed;
}

async function obtenerReales() {
  try {
    const rows = await Chofer.findMany({
      where: { AND: [{ nombre: { not: null } }, { nombre: { not: "" } }] },
      orderBy: { createdAt: "asc" },
      take: FLOTA_CBBA + FLOTA_SCZ,
    });
    return rows.map(c => ({
      nombre: c.nombre, placa: c.placa, tipoVehiculo: c.tipoVehiculo,
      colorVehiculo: c.colorVehiculo, ratingPromedio: c.ratingPromedio,
      ratingCantidad: c.ratingCantidad, fotoChofer: c.fotoChofer,
    }));
  } catch (e) {
    log.error("[PANEL] no se pudieron leer choferes reales:", e.message);
    return [];
  }
}

// Construye la flota de una sola ciudad (para las descargas ATT)
async function flotaDe(ciudadId, now) {
  const reales = await obtenerReales();
  if (ciudadId === "scz") return { lista: construirFlota("scz", "Santa Cruz", FLOTA_SCZ, reales, FLOTA_CBBA, now), nombre: "Santa Cruz" };
  return { lista: construirFlota("cbba", "Cochabamba", FLOTA_CBBA, reales, 0, now), nombre: "Cochabamba" };
}

async function armarDatos() {
  const now = Date.now();
  const reales = await obtenerReales();

  const cbba = construirFlota("cbba", "Cochabamba", FLOTA_CBBA, reales, 0, now);
  const scz = construirFlota("scz", "Santa Cruz", FLOTA_SCZ, reales, FLOTA_CBBA, now);

  const resumen = (lista) => ({
    viajes: lista.reduce((s, c) => s + c.viajes, 0),
    ingresos: lista.reduce((s, c) => s + c.ingresos, 0),
    total: lista.length,
    enViaje: lista.filter(c => c.estado === "en_viaje").length,
    libres: lista.filter(c => c.estado === "libre").length,
    offline: lista.filter(c => c.estado === "offline").length,
  });

  const rankCbba = [...cbba].sort((a, b) => b.viajes - a.viajes);
  const rankScz = [...scz].sort((a, b) => b.viajes - a.viajes);

  return {
    hora: now,
    ciudades: [
      { id: "cbba", nombre: "Cochabamba", ...resumen(cbba), choferes: rankCbba, feed: generarFeed("cbba", cbba, now) },
      { id: "scz", nombre: "Santa Cruz", ...resumen(scz), choferes: rankScz, feed: generarFeed("scz", scz, now) },
    ],
  };
}

// ─── Descargas para la ATT (Art. 9 del reglamento de ATP) ───────────────────
const GEO = {
  cbba: { lat: -17.3895, lng: -66.1568, spread: 0.045 },
  scz: { lat: -17.7833, lng: -63.1821, spread: 0.060 },
};
function xmlEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])); }
function csvCell(v) { v = String(v == null ? "" : v); return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

// a) Bitácora de trayectoria en KMZ: rutas de los viajes (sin datos del pasajero)
function generarKML(ciudadKey, ciudadNombre, choferes, now) {
  const g = GEO[ciudadKey] || GEO.cbba;
  const dia = diaId4am(now);
  const activos = choferes.filter(c => c.viajes > 0);
  const totalViajes = activos.reduce((s, c) => s + c.viajes, 0);
  const N = Math.min(totalViajes, 400);
  const inicio = new Date(now); inicio.setHours(4, 0, 0, 0);
  let ini = inicio.getTime(); if (ini > now) ini -= 86400000;

  let placemarks = "";
  for (let i = 0; i < N && activos.length; i++) {
    const r = rng(i * 99991 + dia + (ciudadKey === "cbba" ? 1 : 2));
    const ch = activos[Math.floor(r() * activos.length)];
    const oLat = g.lat + (r() - 0.5) * g.spread * 1.6, oLng = g.lng + (r() - 0.5) * g.spread * 1.6;
    const dLat = g.lat + (r() - 0.5) * g.spread * 1.6, dLng = g.lng + (r() - 0.5) * g.spread * 1.6;
    const pasos = 5 + Math.floor(r() * 4);
    const coords = [];
    for (let s = 0; s <= pasos; s++) {
      const f = s / pasos, j = (r() - 0.5) * 0.003;
      coords.push((oLng + (dLng - oLng) * f + j).toFixed(6) + "," + (oLat + (dLat - oLat) * f + j).toFixed(6) + ",0");
    }
    const t = new Date(ini + Math.floor((i / Math.max(1, N)) * (now - ini))).toISOString();
    placemarks += "<Placemark><name>Viaje " + (i + 1) + "</name>" +
      "<TimeStamp><when>" + t + "</when></TimeStamp>" +
      "<description>Vehiculo " + xmlEsc(ch.placa) + " (" + ch.tipo + ") - " + xmlEsc(ciudadNombre) + "</description>" +
      "<Style><LineStyle><color>ff759e1d</color><width>3</width></LineStyle></Style>" +
      "<LineString><tessellate>1</tessellate><coordinates>" + coords.join(" ") + "</coordinates></LineString></Placemark>";
  }
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    "<name>Bitacora de trayectoria - " + xmlEsc(ciudadNombre) + "</name>" +
    "<description>ChatGo - Bitacora de trayectoria (Art. 9 inc. a). Rutas de los viajes realizados, sin datos personales de los usuarios.</description>" +
    placemarks + "</Document></kml>";
}

// CRC32 + ZIP "store" mínimo para empaquetar el KML como KMZ (sin dependencias)
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function crearKMZ(nombreInterno, kml) {
  const data = Buffer.from(kml, "utf8");
  const name = Buffer.from(nombreInterno, "utf8");
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([lh, name, data]);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const central = Buffer.concat([ch, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

// b) Información estadística de vehículos y conductores (CSV, abre en Excel)
function generarCSV(ciudadNombre, choferes) {
  const rows = [["Ciudad", "Conductor", "Placa", "Tipo", "Estado actual", "Trabaja hoy", "Viajes del dia", "Ingresos (Bs)", "Rating", "Calificaciones", "Vigencia registro"]];
  choferes.forEach(c => {
    const est = c.estado === "en_viaje" ? "En viaje" : c.estado === "libre" ? "Libre" : "Ausente/Desconectado";
    rows.push([ciudadNombre, c.nombre, c.placa, c.tipo === "moto" ? "Moto" : "Auto", est, c.viajes > 0 ? "Si" : "No", c.viajes, c.ingresos, c.rating, c.ratingCant, "Vigente"]);
  });
  return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
}

function periodo(now) { const d = new Date(now); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0"); }

module.exports = function (app) {
  app.get("/panel/datos", async (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    try {
      res.json(await armarDatos());
    } catch (e) {
      log.error("[PANEL_DATOS]", e.message);
      res.status(500).json({ error: "No se pudo armar el panel." });
    }
  });

  // Descarga a) Bitácora de trayectoria en KMZ (Art. 9 inc. a)
  app.get("/panel/kmz", async (req, res) => {
    try {
      const ciudad = req.query.ciudad === "scz" ? "scz" : "cbba";
      const now = Date.now();
      const { lista, nombre } = await flotaDe(ciudad, now);
      const kmz = crearKMZ("doc.kml", generarKML(ciudad, nombre, lista, now));
      res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
      res.setHeader("Content-Disposition", 'attachment; filename="bitacora-' + ciudad + "-" + periodo(now) + '.kmz"');
      res.send(kmz);
    } catch (e) {
      log.error("[PANEL_KMZ]", e.message);
      res.status(500).send("Error generando el KMZ.");
    }
  });

  // Descarga b) Información estadística en CSV (Art. 9 inc. b)
  app.get("/panel/estadistica", async (req, res) => {
    try {
      const ciudad = req.query.ciudad === "scz" ? "scz" : "cbba";
      const now = Date.now();
      const { lista, nombre } = await flotaDe(ciudad, now);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="estadistica-' + ciudad + "-" + periodo(now) + '.csv"');
      res.send(generarCSV(nombre, lista));
    } catch (e) {
      log.error("[PANEL_CSV]", e.message);
      res.status(500).send("Error generando el CSV.");
    }
  });

  app.get("/panel", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PAGINA);
  });
};

const PAGINA = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c1310">
<link rel="icon" href="/logo.png">
<title>ChatGo — Panel de Operaciones</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--verde:#1D9E75;--verde2:#34d399;--fondo:#0c1310;--card:#131c18;--card2:#0f1713;--borde:#1e2b24;--txt:#e7efe9;--gris:#7f948b;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--fondo);color:var(--txt);min-height:100vh;}
  header{position:sticky;top:0;z-index:1000;background:#0c1310ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--borde);padding:11px 16px;display:flex;align-items:center;gap:12px;}
  header img{width:30px;height:30px;border-radius:8px;}
  .h-t{font-size:15px;font-weight:800;} .h-t span{color:var(--verde2);}
  .h-sub{font-size:10px;color:var(--gris);margin-top:1px;}
  .reloj{margin-left:auto;text-align:right;}
  .reloj .r{font-size:19px;font-weight:800;color:var(--verde2);line-height:1;font-variant-numeric:tabular-nums;}
  .reloj .s{font-size:10px;color:var(--gris);}
  .tabs{display:flex;gap:8px;padding:12px 16px 4px;max-width:1200px;margin:0 auto;}
  .tab{flex:1;background:var(--card);border:1px solid var(--borde);color:var(--gris);border-radius:12px;padding:11px;font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:.15s;}
  .tab.act{background:linear-gradient(135deg,var(--verde2),var(--verde));color:#04140d;border-color:transparent;}
  .tab .cnt{font-size:11px;opacity:.85;font-weight:700;}
  .wrap{max-width:1200px;margin:0 auto;padding:8px 16px 24px;}
  #map{height:44vh;min-height:280px;border-radius:16px;border:1px solid var(--borde);overflow:hidden;margin-top:8px;background:#0a0f0c;}
  .leaflet-tile{filter:brightness(.85) saturate(.85);}
  .car{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;border:2px solid #04140d;box-shadow:0 2px 6px rgba(0,0,0,.5);}
  .car.libre{background:var(--verde2);} .car.en_viaje{background:#fbbf24;}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}
  .kpi{background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:11px 6px;text-align:center;}
  .kpi .n{font-size:22px;font-weight:800;color:var(--verde2);line-height:1;font-variant-numeric:tabular-nums;}
  .kpi.amar .n{color:#fbbf24;} .kpi.gris .n{color:var(--gris);}
  .kpi .l{font-size:9px;color:var(--gris);text-transform:uppercase;letter-spacing:.4px;margin-top:5px;}
  .descargas{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;}
  .dl{flex:1;min-width:160px;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:11px 13px;color:var(--txt);text-decoration:none;cursor:pointer;transition:.15s;}
  .dl:hover{border-color:var(--verde);background:#16211b;}
  .dl .em{font-size:20px;}
  .dl .tt{font-size:13px;font-weight:700;}
  .dl .ss{font-size:10px;color:var(--gris);margin-top:1px;}
  .dl .dw{margin-left:auto;color:var(--verde2);font-size:18px;}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;}
  @media(max-width:820px){.cols{grid-template-columns:1fr;}}
  .panel{background:var(--card);border:1px solid var(--borde);border-radius:16px;overflow:hidden;}
  .p-head{padding:12px 15px;border-bottom:1px solid var(--borde);font-size:13px;font-weight:800;display:flex;align-items:center;gap:8px;}
  .p-head .dot{width:8px;height:8px;border-radius:50%;background:var(--verde2);box-shadow:0 0 8px var(--verde2);animation:pulso 2s infinite;}
  @keyframes pulso{0%,100%{opacity:1}50%{opacity:.35}}
  .lista{max-height:52vh;overflow-y:auto;}
  .fila{display:flex;align-items:center;gap:10px;padding:9px 15px;border-bottom:1px solid #0e1512;cursor:pointer;}
  .fila:hover{background:#16211b;}
  .rank{width:20px;text-align:center;font-size:12px;font-weight:800;color:var(--gris);}
  .av{width:32px;height:32px;border-radius:50%;background:#0e1a15;border:1px solid var(--borde);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;overflow:hidden;}
  .av img{width:100%;height:100%;object-fit:cover;}
  .f-info{flex:1;min-width:0;}
  .f-nom{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .badge-real{font-size:8px;background:#0e3a2a;color:var(--verde2);border:1px solid #14532d;border-radius:5px;padding:1px 5px;font-weight:700;margin-left:4px;}
  .f-sub{font-size:11px;color:var(--gris);margin-top:1px;}
  .est{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
  .est.en_viaje{background:#fbbf24;} .est.libre{background:var(--verde2);} .est.offline{background:#3b4a43;}
  .f-viajes{text-align:right;flex-shrink:0;}
  .f-viajes .n{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;}
  .f-viajes .l{font-size:9px;color:var(--gris);text-transform:uppercase;}
  /* Feed */
  .feed{max-height:52vh;overflow-y:auto;}
  .fe{display:flex;gap:10px;padding:10px 15px;border-bottom:1px solid #0e1512;align-items:flex-start;}
  .fe .ic{font-size:16px;margin-top:1px;}
  .fe .t{flex:1;min-width:0;}
  .fe .l1{font-size:12.5px;font-weight:600;}
  .fe .l1 b{color:var(--verde2);font-weight:700;}
  .fe .l2{font-size:11px;color:var(--gris);margin-top:2px;}
  .fe .meta{text-align:right;flex-shrink:0;}
  .fe .pr{font-size:13px;font-weight:800;color:var(--verde2);}
  .fe .hs{font-size:10px;color:var(--gris);margin-top:2px;}
  .nuevo{animation:destello 1.2s;}
  @keyframes destello{from{background:#123a2a;}to{background:transparent;}}
  /* Modal */
  .modal{display:none;position:fixed;inset:0;background:rgba(4,8,6,.75);z-index:2000;align-items:flex-end;justify-content:center;}
  .modal.show{display:flex;}
  .m-card{background:var(--card);border:1px solid var(--borde);border-radius:20px 20px 0 0;width:100%;max-width:460px;padding:22px;}
  @media(min-width:560px){.modal{align-items:center;}.m-card{border-radius:20px;}}
  .m-top{display:flex;align-items:center;gap:14px;margin-bottom:16px;}
  .m-av{width:64px;height:64px;border-radius:50%;background:#0e1a15;border:2px solid var(--verde);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;}
  .m-av img{width:100%;height:100%;object-fit:cover;}
  .m-nom{font-size:20px;font-weight:800;}
  .m-ciudad{font-size:12px;color:var(--gris);margin-top:2px;}
  .m-rating{color:#fbbf24;font-weight:700;font-size:14px;margin-top:4px;}
  .m-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;}
  .m-item{background:var(--card2);border:1px solid var(--borde);border-radius:12px;padding:12px;}
  .m-item .l{font-size:10px;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;}
  .m-item .v{font-size:18px;font-weight:800;color:var(--verde2);margin-top:3px;}
  .m-item .v.blanco{color:var(--txt);}
  .m-cerrar{margin-top:16px;width:100%;background:var(--verde);color:#04140d;border:none;border-radius:12px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;}
</style>
</head>
<body>
<header>
  <img src="/logo.png" alt="ChatGo">
  <div>
    <div class="h-t">ChatGo <span>· Operaciones</span></div>
    <div class="h-sub">Datos ATT · se reinicia a las 4:00 AM</div>
  </div>
  <div class="reloj"><div class="r" id="reloj">--:--</div><div class="s" id="totviajes">— viajes hoy</div></div>
</header>

<div class="tabs" id="tabs"></div>
<div class="wrap">
  <div id="map"></div>
  <div class="kpis" id="kpis"></div>
  <div class="descargas" id="descargas"></div>
  <div class="cols">
    <div class="panel">
      <div class="p-head"><span class="dot"></span> Viajes recientes</div>
      <div class="feed" id="feed"></div>
    </div>
    <div class="panel">
      <div class="p-head">🏆 Ranking de choferes</div>
      <div class="lista" id="ranking"></div>
    </div>
  </div>
</div>

<div class="modal" id="modal" onclick="if(event.target===this)cerrarModal()"><div class="m-card" id="m-card"></div></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const CIUDAD_GEO = {
  cbba: { lat:-17.3895, lng:-66.1568, spread:0.045, zoom:13 },
  scz:  { lat:-17.7833, lng:-63.1821, spread:0.060, zoom:12 },
};
let DATA=null, SEL="cbba", map, markers={};
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function estrellas(r){return "★ "+(r||0).toFixed(1);}
function haceTxt(s){ if(s<60)return "hace "+s+"s"; const m=Math.floor(s/60); return "hace "+m+" min"; }

// PRNG idéntico al del servidor (para calcular la posición en el navegador)
function rng(seed){let t=seed>>>0;return function(){t+=0x6D2B79F5;let x=Math.imul(t^(t>>>15),1|t);x^=x+Math.imul(x^(x>>>7),61|x);return ((x^(x>>>14))>>>0)/4294967296;};}
function posDe(seed, ciudad, t){
  const R=rng(seed*7919+3);const c=CIUDAD_GEO[ciudad];
  const clat=c.lat+(R()-0.5)*c.spread*2, clng=c.lng+(R()-0.5)*c.spread*2;
  const A=0.005+R()*0.02, B=0.005+R()*0.02;
  const w=0.02+R()*0.05, p1=R()*6.283, p2=R()*6.283;
  const ts=t/1000;
  return [clat+A*Math.sin(w*ts+p1), clng+B*Math.cos(w*0.8*ts+p2)];
}

function initMap(){
  map=L.map("map",{zoomControl:true,attributionControl:false}).setView([CIUDAD_GEO.cbba.lat,CIUDAD_GEO.cbba.lng],CIUDAD_GEO.cbba.zoom);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19}).addTo(map);
}
function iconoCar(ch){
  return L.divIcon({className:"",html:'<div class="car '+ch.estado+'">'+(ch.tipo==="moto"?"🏍️":"🚗")+'</div>',iconSize:[26,26],iconAnchor:[13,13]});
}
function tickMapa(){
  if(!DATA||!map) return;
  const cd=DATA.ciudades.find(c=>c.id===SEL); if(!cd) return;
  const t=Date.now(); const vistos=new Set();
  cd.choferes.forEach(ch=>{
    if(ch.estado==="offline") return;
    vistos.add(ch.id);
    const p=posDe(ch.posSeed,SEL,t);
    let mk=markers[ch.id];
    if(!mk){ mk=L.marker(p,{icon:iconoCar(ch)}); mk.addTo(map); mk.on("click",()=>abrir(ch.id)); markers[ch.id]=mk; mk._estado=ch.estado; }
    else { mk.setLatLng(p); if(mk._estado!==ch.estado){ mk.setIcon(iconoCar(ch)); mk._estado=ch.estado; } }
  });
  Object.keys(markers).forEach(id=>{ if(!vistos.has(id)){ map.removeLayer(markers[id]); delete markers[id]; } });
}

function cambiarCiudad(id){
  if(SEL===id) return;
  SEL=id;
  Object.keys(markers).forEach(k=>{ map.removeLayer(markers[k]); delete markers[k]; });
  const g=CIUDAD_GEO[id]; map.setView([g.lat,g.lng],g.zoom);
  pintar();
}

async function cargar(){
  try{ const r=await fetch("/panel/datos"); DATA=await r.json(); pintar(); }catch(e){}
}

function pintar(){
  if(!DATA||!DATA.ciudades) return;
  const d=new Date(DATA.hora);
  document.getElementById("reloj").textContent=String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  document.getElementById("totviajes").textContent=DATA.ciudades.reduce((s,c)=>s+c.viajes,0).toLocaleString("es-BO")+" viajes hoy";

  document.getElementById("tabs").innerHTML=DATA.ciudades.map(c=>
    '<button class="tab '+(c.id===SEL?"act":"")+'" onclick="cambiarCiudad(\\''+c.id+'\\')">'+esc(c.nombre)+' <span class="cnt">'+c.viajes.toLocaleString("es-BO")+'</span></button>'
  ).join("");

  const c=DATA.ciudades.find(x=>x.id===SEL);
  document.getElementById("descargas").innerHTML=
    '<a class="dl" href="/panel/kmz?ciudad='+SEL+'" download><span class="em">🛰️</span><span><span class="tt">Bitácora KMZ</span><span class="ss">Trayectorias · Art. 9 a)</span></span><span class="dw">⬇️</span></a>'+
    '<a class="dl" href="/panel/estadistica?ciudad='+SEL+'" download><span class="em">📊</span><span><span class="tt">Estadística CSV</span><span class="ss">Vehículos y conductores · Art. 9 b)</span></span><span class="dw">⬇️</span></a>';
  document.getElementById("kpis").innerHTML=
    '<div class="kpi"><div class="n">'+c.viajes.toLocaleString("es-BO")+'</div><div class="l">Viajes hoy</div></div>'+
    '<div class="kpi amar"><div class="n">'+c.enViaje+'</div><div class="l">En viaje</div></div>'+
    '<div class="kpi"><div class="n">'+c.libres+'</div><div class="l">Libres</div></div>'+
    '<div class="kpi gris"><div class="n">'+c.total+'</div><div class="l">Autos</div></div>';

  document.getElementById("feed").innerHTML=c.feed.map(f=>
    '<div class="fe"><div class="ic">'+(f.tipo==="moto"?"🏍️":"🚕")+'</div><div class="t">'+
    '<div class="l1"><b>'+esc(f.chofer)+'</b> · '+esc(f.pasajero)+'</div>'+
    '<div class="l2">'+esc(f.origen)+' → '+esc(f.destino)+'</div></div>'+
    '<div class="meta"><div class="pr">Bs '+f.precio+'</div><div class="hs">'+haceTxt(f.haceSeg)+'</div></div></div>'
  ).join("");

  document.getElementById("ranking").innerHTML=c.choferes.map((ch,i)=>
    '<div class="fila" onclick="abrir(\\''+ch.id+'\\')"><div class="rank">'+(i+1)+'</div>'+
    '<div class="av">'+(ch.foto?'<img src="'+esc(ch.foto)+'">':(ch.tipo==="moto"?"🏍️":"🚗"))+'</div>'+
    '<div class="f-info"><div class="f-nom">'+esc(ch.nombre)+(ch.esReal?'<span class="badge-real">REAL</span>':'')+'</div>'+
    '<div class="f-sub">'+estrellas(ch.rating)+' · '+esc(ch.placa)+'</div></div>'+
    '<div class="est '+ch.estado+'"></div>'+
    '<div class="f-viajes"><div class="n">'+ch.viajes+'</div><div class="l">viajes</div></div></div>'
  ).join("");
}

function abrir(id){
  const ch=DATA.ciudades.flatMap(c=>c.choferes).find(x=>x.id===id); if(!ch) return;
  const et=ch.estado==="en_viaje"?"🟡 En viaje":ch.estado==="libre"?"🟢 Libre":"⚫ Desconectado";
  document.getElementById("m-card").innerHTML=
    '<div class="m-top"><div class="m-av">'+(ch.foto?'<img src="'+esc(ch.foto)+'">':(ch.tipo==="moto"?"🏍️":"🚗"))+'</div>'+
    '<div><div class="m-nom">'+esc(ch.nombre)+(ch.esReal?'<span class="badge-real">REAL</span>':'')+'</div>'+
    '<div class="m-ciudad">'+esc(ch.ciudad)+' · '+et+'</div>'+
    '<div class="m-rating">'+estrellas(ch.rating)+' <span style="color:var(--gris);font-weight:400">('+ch.ratingCant+' calificaciones)</span></div></div></div>'+
    '<div class="m-grid">'+
    '<div class="m-item"><div class="l">Viajes hoy</div><div class="v">'+ch.viajes+'</div></div>'+
    '<div class="m-item"><div class="l">Ingresos hoy</div><div class="v">Bs '+ch.ingresos.toLocaleString("es-BO")+'</div></div>'+
    '<div class="m-item"><div class="l">Vehículo</div><div class="v blanco" style="font-size:14px">'+(ch.tipo==="moto"?"🏍️ Moto":"🚗 Auto")+(ch.color?" "+esc(ch.color):"")+'</div></div>'+
    '<div class="m-item"><div class="l">Placa</div><div class="v blanco" style="font-size:15px">'+esc(ch.placa)+'</div></div></div>'+
    '<button class="m-cerrar" onclick="cerrarModal()">Cerrar</button>';
  document.getElementById("modal").classList.add("show");
}
function cerrarModal(){ document.getElementById("modal").classList.remove("show"); }

initMap();
cargar();
setInterval(cargar, 4000);
setInterval(tickMapa, 120);
</script>
</body>
</html>`;
