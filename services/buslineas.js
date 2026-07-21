// ChatGo — Líneas de BUS (demo server-side)
//
// Las mismas 25 líneas de la demo web (public/bus-demo.html), pero en el
// servidor y con una propiedad clave: los micros se simulan de forma
// DETERMINISTA en función del reloj — la posición de cualquier micro en
// cualquier instante se calcula al momento, sin intervals ni estado en
// memoria. Cero costo de fondo, y el WhatsApp y la página del pasajero ven
// exactamente lo mismo.

// Haversine local (sin dependencias — este módulo es geometría pura)
function distanciaEntrePuntos(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PUNTOS = {
  "Plaza Colón":[-17.3895,-66.1568], "Quillacollo":[-17.3830,-66.2850], "San Sebastián":[-17.3980,-66.1520],
  "Sacaba":[-17.4020,-66.0400], "Cala Cala":[-17.3650,-66.1480], "Zona Sud":[-17.4600,-66.1700],
  "UMSS":[-17.3935,-66.1450], "Aeropuerto":[-17.4580,-66.1750], "Terminal":[-17.3960,-66.1560],
  "Tiquipaya":[-17.3330,-66.2150], "La Cancha":[-17.4000,-66.1580], "Colcapirhua":[-17.3900,-66.2400],
  "Vinto":[-17.3960,-66.3100], "Pacata":[-17.3600,-66.1200], "Villa Busch":[-17.4100,-66.1850],
  "Recoleta":[-17.3760,-66.1560], "Muyurina":[-17.3810,-66.1440], "La Chimba":[-17.4050,-66.1720],
  "Jayhuayco":[-17.4180,-66.1550], "Valle Hermoso":[-17.4300,-66.1350], "Alalay":[-17.4150,-66.1400],
  "Sarco":[-17.3850,-66.1780], "Temporal":[-17.3880,-66.1350], "Hipódromo":[-17.3750,-66.1700],
  "Chiquicollo":[-17.3700,-66.1900], "Condebamba":[-17.3780,-66.1820], "Coña Coña":[-17.3850,-66.2150],
  "Ticti Norte":[-17.3550,-66.1650], "Pucara":[-17.4350,-66.1200], "El Abra":[-17.4450,-66.1000],
};

const RUTAS_BASE = [
  ["Plaza Colón","Quillacollo"], ["San Sebastián","Sacaba"], ["Cala Cala","Zona Sud"],
  ["UMSS","Aeropuerto"], ["Terminal","Tiquipaya"], ["La Cancha","Colcapirhua"],
  ["Recoleta","Vinto"], ["Pacata","Villa Busch"], ["Muyurina","Jayhuayco"],
  ["La Chimba","Ticti Norte"], ["Valle Hermoso","Sarco"], ["Alalay","Hipódromo"],
  ["Temporal","Coña Coña"], ["Condebamba","Pucara"], ["Chiquicollo","El Abra"],
  ["Quillacollo","Sacaba"], ["Tiquipaya","Zona Sud"], ["Aeropuerto","Cala Cala"],
  ["Vinto","La Cancha"], ["Sarco","Pacata"], ["Jayhuayco","Recoleta"],
  ["El Abra","Plaza Colón"], ["Coña Coña","Muyurina"], ["Pucara","Terminal"],
  ["Ticti Norte","Valle Hermoso"],
];

const NOMBRES_LINEA = ["1","2","3","4","5","B","Q","G","K","Z","3V","7","10","13","18","22","30","35","103","110","130","212","230","260","290"];

// Mismo generador de ruta que la demo web (zigzag determinista)
function generarRuta(a, b, semilla) {
  const puntos = [];
  const pasos = 10;
  for (let i = 0; i <= pasos; i++) {
    const f = i / pasos;
    let lat = a[0] + (b[0] - a[0]) * f;
    let lng = a[1] + (b[1] - a[1]) * f;
    if (i > 0 && i < pasos) {
      const amp = 0.004 * Math.sin(semilla * 7 + i * 2.1);
      lat += amp * 0.6;
      lng += amp * (semilla % 2 === 0 ? 1 : -1) * 0.8;
    }
    puntos.push([lat, lng]);
  }
  return puntos;
}

const LINEAS = RUTAS_BASE.map(([o, d], i) => {
  const ruta = generarRuta(PUNTOS[o], PUNTOS[d], i + 1);
  // Largo total en km (para ETAs)
  let largoKm = 0;
  for (let j = 0; j < ruta.length - 1; j++) {
    largoKm += distanciaEntrePuntos(ruta[j][0], ruta[j][1], ruta[j + 1][0], ruta[j + 1][1]);
  }
  return {
    id: i + 1,
    nombre: "Línea " + NOMBRES_LINEA[i],
    color: `hsl(${Math.round(i * 137.5) % 360}, 72%, 55%)`,
    origen: o, destino: d,
    ruta, largoKm,
  };
});

// ─── Geometría ────────────────────────────────────────────────────────────────

// Posición {lat,lng} en la ruta para un t de 0 a 1
function posicionEnRuta(ruta, t) {
  const segmentos = ruta.length - 1;
  const pos = Math.max(0, Math.min(t, 1)) * segmentos;
  const i = Math.min(Math.floor(pos), segmentos - 1);
  const frac = pos - i;
  return {
    lat: ruta[i][0] + (ruta[i + 1][0] - ruta[i][0]) * frac,
    lng: ruta[i][1] + (ruta[i + 1][1] - ruta[i][1]) * frac,
  };
}

// Proyecta un punto sobre la polilínea: devuelve { distM, t } del punto más
// cercano de la ruta (proyección sobre cada segmento, plano local aproximado)
function proyectarPunto(linea, lat, lng) {
  const ruta = linea.ruta;
  const cosLat = Math.cos(lat * Math.PI / 180);
  let mejor = { distM: Infinity, t: 0 };
  for (let i = 0; i < ruta.length - 1; i++) {
    const ax = ruta[i][1] * cosLat, ay = ruta[i][0];
    const bx = ruta[i + 1][1] * cosLat, by = ruta[i + 1][0];
    const px = lng * cosLat, py = lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const cx = ax + u * dx, cy = ay + u * dy;
    const distM = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) * 111000; // grados → metros aprox
    if (distM < mejor.distM) {
      mejor = { distM: Math.round(distM), t: (i + u) / (ruta.length - 1) };
    }
  }
  return mejor;
}

// ─── Micros deterministas ────────────────────────────────────────────────────
// 20 micros por línea. Cada micro es función del reloj: semilla → fase inicial
// y velocidad; el "ping-pong" (ida y vuelta) sale de un módulo 2.

function _frac(x) { return x - Math.floor(x); }
function _rand(seed) { return _frac(Math.sin(seed * 12.9898) * 43758.5453); }

const MICROS_POR_LINEA = 20;

function microsDeLinea(linea, cuando = Date.now()) {
  const micros = [];
  for (let i = 0; i < MICROS_POR_LINEA; i++) {
    const seed = linea.id * 100 + i;
    const t0 = _rand(seed);
    // velocidad en t/segundo (misma escala que la demo: 0.0008-0.0014 por tick de 150ms)
    const velSeg = (0.0008 + _rand(seed * 1.7) * 0.0006) / 0.15;
    const raw = t0 + velSeg * (cuando / 1000);
    const tt = _frac(raw / 2) * 2;        // ciclo 0..2
    const t = tt < 1 ? tt : 2 - tt;       // ping-pong 0..1..0
    const direccion = tt < 1 ? 1 : -1;
    micros.push({
      id: i + 1,
      t, direccion, velSeg,
      pos: posicionEnRuta(linea.ruta, t),
    });
  }
  return micros;
}

// El micro que "viene a la espalda" del pasajero: el más próximo que se
// dirige HACIA su parada (tParada) en su dirección actual de recorrido.
function microMasProximo(linea, tParada, cuando = Date.now()) {
  const micros = microsDeLinea(linea, cuando);
  let mejor = null;
  for (const m of micros) {
    let distT = null;
    if (m.direccion === 1 && m.t <= tParada) distT = tParada - m.t;
    else if (m.direccion === -1 && m.t >= tParada) distT = m.t - tParada;
    if (distT === null) continue; // se aleja: no es "el que viene"
    if (!mejor || distT < mejor.distT) mejor = { ...m, distT };
  }
  if (!mejor) {
    // Ninguno viene directo (todos alejándose): tomar el que menos tarda en
    // dar la vuelta y volver (distancia en el ciclo ping-pong)
    for (const m of micros) {
      const distT = m.direccion === 1 ? (1 - m.t) + (1 - tParada) : m.t + tParada;
      if (!mejor || distT < mejor.distT) mejor = { ...m, distT };
    }
  }
  const etaMin = Math.max(1, Math.round(mejor.distT / mejor.velSeg / 60));
  const kmDeDistancia = Math.round(mejor.distT * linea.largoKm * 10) / 10;
  return { ...mejor, etaMin, kmDeDistancia };
}

// ─── Buscar línea para un viaje ──────────────────────────────────────────────
// Devuelve las líneas que pasan cerca de AMBOS puntos, ordenadas por cercanía
// combinada. maxM = qué tan lejos puede quedar la parada (caminata razonable).
function buscarLineasParaViaje(origen, destino, maxM = 1200) {
  const candidatas = [];
  for (const linea of LINEAS) {
    const pO = proyectarPunto(linea, origen.lat, origen.lng);
    const pD = proyectarPunto(linea, destino.lat, destino.lng);
    if (pO.distM <= maxM && pD.distM <= maxM) {
      candidatas.push({ linea, pO, pD, score: pO.distM + pD.distM });
    }
  }
  candidatas.sort((a, b) => a.score - b.score);
  return candidatas;
}

module.exports = { LINEAS, PUNTOS, posicionEnRuta, proyectarPunto, microsDeLinea, microMasProximo, buscarLineasParaViaje, MICROS_POR_LINEA };
