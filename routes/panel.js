// ChatGo — Panel de Operaciones (simulación por ciudad)
//
// GET /panel        → dashboard con 2 ciudades (Cochabamba y Santa Cruz)
// GET /panel/datos  → JSON con viajes por ciudad y por chofer (poll cada 5s)
//
// TODO es determinista y CALCULADO en base a la hora (no se escribe en la base):
// por eso el link NUNCA se rompe y "se reinicia" solo a las 4:00 AM (los conteos
// son función del tiempo transcurrido desde las 4am). Usa los nombres reales de
// choferes de la base y completa hasta 140 autos (120 Cochabamba + 20 Santa Cruz).

const { Chofer } = require("../db/models");
const { log } = require("../config");

const FLOTA_CBBA = 120;
const FLOTA_SCZ = 20;

// Curva de demanda por hora (misma forma que el demo): pico mañana/mediodía/tarde
function factorHora(h) {
  const c = [0.2,0.1,0.1,0.1,0.2,0.4, 0.8,1.4,1.6,1.2,0.9,1.0, 1.5,1.4,1.0,0.9,1.0,1.3, 1.8,1.6,1.4,1.0,0.6,0.4];
  return c[h] || 1.0;
}
const TOTAL_DIA = (() => { let s = 0; for (let h = 0; h < 24; h++) s += factorHora(h); return s; })();

// Unidades de demanda acumuladas desde las 4:00 AM hasta "ahora"
function unidadesDesde4(now) {
  const d = new Date(now);
  const h = d.getHours(), m = d.getMinutes();
  const horasPasadas = (h - 4 + 24) % 24;
  let u = 0;
  for (let k = 0; k < horasPasadas; k++) u += factorHora((4 + k) % 24);
  u += factorHora(h) * (m / 60);
  return u;
}

// Id de día que cambia a las 4am (para variar la simulación cada día, estable dentro del día)
function diaId4am(now) {
  const d = new Date(now - 4 * 3600 * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// PRNG determinista (mulberry32)
function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Nombres bolivianos para completar la flota simulada (los reales salen primero)
const NOMBRES = ["Carlos","José","Luis","Juan","Marco","Freddy","Rodrigo","Álvaro","Grover","Wilson","Edwin","Ramiro","René","Óscar","Javier","Mauricio","Gonzalo","Iván","David","Richard","Gabriel","Nelson","Rubén","Hugo","Fernando","Roberto","Miguel","Sergio","Daniel","Pablo","Ariel","Cristian","Jhonny","Limbert","Vladimir","Boris","Wálter","Germán","Marcelo","Ronald","Adhemar","Willy","Elvis","Franz","Efraín","Delfín","Saúl","Abraham","Néstor","Vicente"];
const APELLIDOS = ["Mamani","Quispe","Choque","Flores","Condori","Vargas","Rojas","Colque","Ticona","Apaza","Gutiérrez","Fernández","Rodríguez","Villca","Cruz","Torrez","Camacho","Céspedes","Ledezma","Zeballos","Arispe","Montaño","Balderrama","Sejas","Terrazas","Claros","Peredo","Antezana","Escóbar","Ovando","Guzmán","Salvatierra","Suárez","Áñez","Justiniano","Roca","Cuéllar","Menacho","Parada","Áñez"];

function nombreGenerado(i) {
  const r = rng(i * 2654435761 + 12345);
  const n = NOMBRES[Math.floor(r() * NOMBRES.length)];
  const a = APELLIDOS[Math.floor(r() * APELLIDOS.length)];
  return n + " " + a;
}
function placaGenerada(i) {
  const r = rng(i * 40503 + 777);
  const num = 1000 + Math.floor(r() * 8999);
  const letras = "ABCDEFGHJKLMNPRSTUVXYZ";
  return num + "-" + letras[Math.floor(r() * letras.length)] + letras[Math.floor(r() * letras.length)] + letras[Math.floor(r() * letras.length)];
}

// Construye la flota de una ciudad: usa choferes reales primero, completa con generados
function construirFlota(ciudadId, ciudadNombre, cantidad, reales, offsetReal, now) {
  const dia = diaId4am(now);
  const u = unidadesDesde4(now);
  const horaAhora = new Date(now).getHours();
  const bucket = Math.floor((Date.now() % (24 * 3600 * 1000)) / (8 * 60 * 1000)); // bucket de 8 min

  const choferes = [];
  for (let k = 0; k < cantidad; k++) {
    const gi = offsetReal + k; // índice global estable
    const real = reales[gi] || null;
    const seed = (gi + 1) * 7919 + dia;
    const r = rng(seed);

    const nombre = real ? real.nombre : nombreGenerado(gi);
    const tipo = real ? (real.tipoVehiculo || "auto") : (r() < 0.12 ? "moto" : "auto");
    const placa = real ? (real.placa || placaGenerada(gi)) : placaGenerada(gi);
    const color = real ? (real.colorVehiculo || "") : ["Blanco","Gris","Negro","Rojo","Azul","Plata"][Math.floor(r() * 6)];

    // Actividad personal del chofer (estable en el día)
    const actividad = 0.6 + r() * 0.9; // 0.6 .. 1.5
    const baseDaily = 12 + Math.floor(r() * 8); // 12..19 viajes/día a full
    const viajes = Math.max(0, Math.round(actividad * baseDaily * (u / TOTAL_DIA)));

    // Rating: real si existe, si no determinista alto
    let rating, ratingCant;
    if (real && real.ratingCantidad > 0) {
      rating = Math.round(real.ratingPromedio * 10) / 10;
      ratingCant = real.ratingCantidad;
    } else {
      rating = Math.round((4.3 + r() * 0.7) * 10) / 10;
      ratingCant = 20 + Math.floor(r() * 400);
    }

    // Estado ahora (varía por bucket de tiempo): offline de noche, ocupado en horas pico
    const rt = rng(seed + bucket * 104729);
    const probOffline = (horaAhora < 6 || horaAhora >= 23) ? 0.6 : 0.12;
    const probOcupado = Math.min(0.75, 0.30 * factorHora(horaAhora));
    const x = rt();
    let estado;
    if (x < probOffline) estado = "offline";
    else if (x < probOffline + probOcupado) estado = "en_viaje";
    else estado = "libre";

    const ingresos = viajes * (tipo === "moto" ? 9 : 16);

    choferes.push({
      id: ciudadId + "-" + gi,
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

async function armarDatos() {
  const now = Date.now();
  let reales = [];
  try {
    const rows = await Chofer.findMany({
      where: { AND: [{ nombre: { not: null } }, { nombre: { not: "" } }] },
      orderBy: { createdAt: "asc" },
      take: FLOTA_CBBA + FLOTA_SCZ,
    });
    reales = rows.map(c => ({
      nombre: c.nombre, placa: c.placa, tipoVehiculo: c.tipoVehiculo,
      colorVehiculo: c.colorVehiculo, ratingPromedio: c.ratingPromedio,
      ratingCantidad: c.ratingCantidad, fotoChofer: c.fotoChofer,
    }));
  } catch (e) {
    log.error("[PANEL] no se pudieron leer choferes reales:", e.message);
  }

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

  // Ordenar choferes por viajes (desc) para el ranking
  cbba.sort((a, b) => b.viajes - a.viajes);
  scz.sort((a, b) => b.viajes - a.viajes);

  return {
    hora: now,
    ciudades: [
      { id: "cbba", nombre: "Cochabamba", ...resumen(cbba), choferes: cbba },
      { id: "scz", nombre: "Santa Cruz", ...resumen(scz), choferes: scz },
    ],
  };
}

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
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--verde:#1D9E75;--verde2:#34d399;--fondo:#0c1310;--card:#131c18;--card2:#0f1713;--borde:#1e2b24;--txt:#e7efe9;--gris:#7f948b;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--fondo);color:var(--txt);min-height:100vh;}
  header{position:sticky;top:0;z-index:10;background:linear-gradient(180deg,#0c1310,#0c1310ee);backdrop-filter:blur(6px);border-bottom:1px solid var(--borde);padding:12px 16px;display:flex;align-items:center;gap:12px;}
  header img{width:32px;height:32px;border-radius:8px;}
  .h-t{font-size:16px;font-weight:800;letter-spacing:.3px;}
  .h-t span{color:var(--verde2);}
  .h-sub{font-size:11px;color:var(--gris);margin-top:1px;}
  .reloj{margin-left:auto;text-align:right;}
  .reloj .r{font-size:20px;font-weight:800;color:var(--verde2);line-height:1;font-variant-numeric:tabular-nums;}
  .reloj .s{font-size:10px;color:var(--gris);}
  .wrap{max-width:1200px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  @media(max-width:820px){.wrap{grid-template-columns:1fr;}}
  .ciudad{background:var(--card);border:1px solid var(--borde);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;}
  .c-head{padding:14px 16px;border-bottom:1px solid var(--borde);}
  .c-nom{font-size:17px;font-weight:800;display:flex;align-items:center;gap:8px;}
  .c-dot{width:9px;height:9px;border-radius:50%;background:var(--verde2);box-shadow:0 0 8px var(--verde2);animation:pulso 2s infinite;}
  @keyframes pulso{0%,100%{opacity:1}50%{opacity:.35}}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}
  .kpi{background:var(--card2);border:1px solid var(--borde);border-radius:10px;padding:8px 6px;text-align:center;}
  .kpi .n{font-size:19px;font-weight:800;color:var(--verde2);line-height:1;font-variant-numeric:tabular-nums;}
  .kpi.amar .n{color:#fbbf24;} .kpi.gris .n{color:var(--gris);}
  .kpi .l{font-size:9px;color:var(--gris);text-transform:uppercase;letter-spacing:.4px;margin-top:4px;}
  .lista{max-height:62vh;overflow-y:auto;}
  .fila{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid #0e1512;cursor:pointer;transition:background .12s;}
  .fila:hover{background:#16211b;}
  .rank{width:22px;text-align:center;font-size:12px;font-weight:800;color:var(--gris);}
  .av{width:34px;height:34px;border-radius:50%;background:#0e1a15;border:1px solid var(--borde);object-fit:cover;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:15px;}
  .f-info{flex:1;min-width:0;}
  .f-nom{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px;}
  .badge-real{font-size:8px;background:#0e3a2a;color:var(--verde2);border:1px solid #14532d;border-radius:5px;padding:1px 5px;font-weight:700;letter-spacing:.3px;}
  .f-sub{font-size:11px;color:var(--gris);margin-top:1px;}
  .est{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
  .est.en_viaje{background:#fbbf24;} .est.libre{background:var(--verde2);} .est.offline{background:#3b4a43;}
  .f-viajes{text-align:right;flex-shrink:0;}
  .f-viajes .n{font-size:16px;font-weight:800;color:var(--txt);line-height:1;font-variant-numeric:tabular-nums;}
  .f-viajes .l{font-size:9px;color:var(--gris);text-transform:uppercase;}
  /* Modal chofer */
  .modal{display:none;position:fixed;inset:0;background:rgba(4,8,6,.75);z-index:50;align-items:flex-end;justify-content:center;}
  .modal.show{display:flex;}
  .m-card{background:var(--card);border:1px solid var(--borde);border-radius:20px 20px 0 0;width:100%;max-width:460px;padding:22px;animation:sube .25s;}
  @media(min-width:560px){.modal{align-items:center;}.m-card{border-radius:20px;}}
  @keyframes sube{from{transform:translateY(30px);opacity:.6}to{transform:translateY(0);opacity:1}}
  .m-top{display:flex;align-items:center;gap:14px;margin-bottom:16px;}
  .m-av{width:64px;height:64px;border-radius:50%;background:#0e1a15;border:2px solid var(--verde);object-fit:cover;display:flex;align-items:center;justify-content:center;font-size:28px;}
  .m-nom{font-size:20px;font-weight:800;}
  .m-ciudad{font-size:12px;color:var(--gris);margin-top:2px;}
  .m-rating{color:#fbbf24;font-weight:700;font-size:14px;margin-top:4px;}
  .m-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;}
  .m-item{background:var(--card2);border:1px solid var(--borde);border-radius:12px;padding:12px;}
  .m-item .l{font-size:10px;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;}
  .m-item .v{font-size:18px;font-weight:800;color:var(--verde2);margin-top:3px;}
  .m-item .v.blanco{color:var(--txt);}
  .m-cerrar{margin-top:16px;width:100%;background:var(--verde);color:#04140d;border:none;border-radius:12px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;}
  .m-cerrar:active{filter:brightness(.92);}
</style>
</head>
<body>
<header>
  <img src="/logo.png" alt="ChatGo">
  <div>
    <div class="h-t">ChatGo <span>· Operaciones</span></div>
    <div class="h-sub">Simulación en vivo · se reinicia a las 4:00 AM</div>
  </div>
  <div class="reloj">
    <div class="r" id="reloj">--:--</div>
    <div class="s" id="totviajes">— viajes hoy</div>
  </div>
</header>

<div class="wrap" id="wrap"></div>

<div class="modal" id="modal" onclick="if(event.target===this)cerrarModal()">
  <div class="m-card" id="m-card"></div>
</div>

<script>
let DATA = null;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function estrellas(r){return "★ "+(r||0).toFixed(1);}

async function cargar(){
  try{
    const r = await fetch("/panel/datos");
    DATA = await r.json();
    pintar();
  }catch(e){ /* reintenta en el próximo tick */ }
}

function pintar(){
  if(!DATA||!DATA.ciudades) return;
  const d = new Date(DATA.hora);
  document.getElementById("reloj").textContent = String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  const totViajes = DATA.ciudades.reduce((s,c)=>s+c.viajes,0);
  document.getElementById("totviajes").textContent = totViajes.toLocaleString("es-BO")+" viajes hoy";

  document.getElementById("wrap").innerHTML = DATA.ciudades.map(c => \`
    <div class="ciudad">
      <div class="c-head">
        <div class="c-nom"><span class="c-dot"></span>\${esc(c.nombre)}</div>
        <div class="kpis">
          <div class="kpi"><div class="n">\${c.viajes.toLocaleString("es-BO")}</div><div class="l">Viajes hoy</div></div>
          <div class="kpi amar"><div class="n">\${c.enViaje}</div><div class="l">En viaje</div></div>
          <div class="kpi"><div class="n">\${c.libres}</div><div class="l">Libres</div></div>
          <div class="kpi gris"><div class="n">\${c.total}</div><div class="l">Autos</div></div>
        </div>
      </div>
      <div class="lista">
        \${c.choferes.map((ch,idx)=>\`
          <div class="fila" onclick="abrir('\${ch.id}')">
            <div class="rank">\${idx+1}</div>
            <div class="av">\${ch.foto?\`<img src="\${esc(ch.foto)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">\`:(ch.tipo==="moto"?"🏍️":"🚗")}</div>
            <div class="f-info">
              <div class="f-nom">\${esc(ch.nombre)} \${ch.esReal?'<span class="badge-real">REAL</span>':''}</div>
              <div class="f-sub">\${estrellas(ch.rating)} · \${esc(ch.placa)}</div>
            </div>
            <div class="est \${ch.estado}"></div>
            <div class="f-viajes"><div class="n">\${ch.viajes}</div><div class="l">viajes</div></div>
          </div>\`).join("")}
      </div>
    </div>\`).join("");
}

function abrir(id){
  const ch = DATA.ciudades.flatMap(c=>c.choferes).find(x=>x.id===id);
  if(!ch) return;
  const estadoTxt = ch.estado==="en_viaje"?"🟡 En viaje":ch.estado==="libre"?"🟢 Libre":"⚫ Desconectado";
  document.getElementById("m-card").innerHTML = \`
    <div class="m-top">
      <div class="m-av">\${ch.foto?\`<img src="\${esc(ch.foto)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">\`:(ch.tipo==="moto"?"🏍️":"🚗")}</div>
      <div>
        <div class="m-nom">\${esc(ch.nombre)} \${ch.esReal?'<span class="badge-real">REAL</span>':''}</div>
        <div class="m-ciudad">\${esc(ch.ciudad)} · \${estadoTxt}</div>
        <div class="m-rating">\${estrellas(ch.rating)} <span style="color:var(--gris);font-weight:400">(\${ch.ratingCant} calificaciones)</span></div>
      </div>
    </div>
    <div class="m-grid">
      <div class="m-item"><div class="l">Viajes hoy</div><div class="v">\${ch.viajes}</div></div>
      <div class="m-item"><div class="l">Ingresos hoy</div><div class="v">Bs \${ch.ingresos.toLocaleString("es-BO")}</div></div>
      <div class="m-item"><div class="l">Vehículo</div><div class="v blanco" style="font-size:14px">\${ch.tipo==="moto"?"🏍️ Moto":"🚗 Auto"}\${ch.color?" "+esc(ch.color):""}</div></div>
      <div class="m-item"><div class="l">Placa</div><div class="v blanco" style="font-size:15px">\${esc(ch.placa)}</div></div>
    </div>
    <button class="m-cerrar" onclick="cerrarModal()">Cerrar</button>\`;
  document.getElementById("modal").classList.add("show");
}
function cerrarModal(){ document.getElementById("modal").classList.remove("show"); }

cargar();
setInterval(cargar, 5000);
</script>
</body>
</html>`;
