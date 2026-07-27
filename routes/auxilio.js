// ChatGo — Auxilio Mecánico (Etapa 1: backend + panel de administración)
//
// Base: gestión de mecánicos afiliados y registro de auxilios. NO toca el bot de
// WhatsApp (eso es la Etapa 2). Todo es aditivo.
//
// Endpoints (admin, protegidos con ?token=AUXILIO_ADMIN_TOKEN):
//   GET  /admin/auxilio                    → panel HTML
//   GET  /admin/auxilio/mecanicos          → lista de mecánicos
//   POST /admin/auxilio/mecanicos          → crear
//   PUT  /admin/auxilio/mecanicos/:id      → editar
//   POST /admin/auxilio/mecanicos/:id/suspender
//   POST /admin/auxilio/mecanicos/:id/activar
//   GET  /admin/auxilio/auxilios?estado=   → lista de auxilios
//   GET  /admin/auxilio/resumen            → totales

const crypto = require("crypto");
const { CONFIG, log } = require("../config");
const { Mecanico, Auxilio } = require("../db/models");

const ESTADOS_SUSCRIPCION = ["mes_gratis", "activa", "vencida", "suspendida"];
const ESTADOS_AUXILIO = ["pendiente", "asignado", "en_camino", "completado", "cancelado"];

// Normaliza un número boliviano a formato internacional (591XXXXXXXX)
function normalizarPhone(input) {
  const num = String(input || "").replace(/\D/g, "");
  if (/^591\d{8}$/.test(num)) return num;
  if (/^[67]\d{7}$/.test(num)) return `591${num}`;
  if (num.length >= 8) return num; // otros países / ya con prefijo
  return null;
}

module.exports = function (app) {
  // ── Auth por token (query string), timing-safe ──────────────────────────────
  function auth(req, res) {
    const token = String(req.query.token || "");
    const esperado = CONFIG.AUXILIO_ADMIN_TOKEN || "";
    let ok = false;
    if (esperado && token.length === esperado.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado)); } catch (_) { ok = false; }
    }
    if (!ok) { res.status(401).json({ error: "No autorizado" }); return false; }
    return true;
  }

  // ── Lista de mecánicos ──────────────────────────────────────────────────────
  app.get("/admin/auxilio/mecanicos", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const mecanicos = await Mecanico.findMany({ orderBy: { createdAt: "desc" } });
      res.json({ mecanicos });
    } catch (e) { log.error("[AUXILIO_MEC_LIST]", e.message); res.status(500).json({ error: "Error al listar." }); }
  });

  // ── Crear mecánico ──────────────────────────────────────────────────────────
  app.post("/admin/auxilio/mecanicos", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const nombre = String(b.nombre || "").trim();
      const telefono = normalizarPhone(b.telefono);
      if (!nombre) return res.status(400).json({ error: "El nombre es requerido." });
      if (!telefono) return res.status(400).json({ error: "Teléfono inválido (usá el celular con código 591)." });

      const existe = await Mecanico.findUnique({ where: { telefono } });
      if (existe) return res.status(409).json({ error: "Ya existe un mecánico con ese teléfono." });

      const susEstado = ESTADOS_SUSCRIPCION.includes(b.suscripcionEstado) ? b.suscripcionEstado : "mes_gratis";
      const mecanico = await Mecanico.create({
        data: {
          nombre,
          telefono,
          zona: b.zona ? String(b.zona).trim() : null,
          ubicacionBase: (typeof b.lat === "number" && typeof b.lng === "number") ? { lat: b.lat, lng: b.lng } : null,
          tiposServicio: Array.isArray(b.tiposServicio) ? b.tiposServicio : [],
          atiende24h: !!b.atiende24h,
          documentos: {
            facturaLuz: !!b.facturaLuz,
            carnet: !!b.carnet,
            nit: b.nit ? String(b.nit).trim() : null,
            verificacionFisica: !!b.verificacionFisica,
            notasVerificacion: b.notasVerificacion ? String(b.notasVerificacion) : null,
          },
          suscripcion: {
            estado: susEstado,
            fechaInicio: new Date().toISOString(),
            fechaVencimiento: b.fechaVencimiento || null,
          },
          activo: true,
        },
      });
      res.json({ ok: true, mecanico });
    } catch (e) { log.error("[AUXILIO_MEC_CREATE]", e.message); res.status(500).json({ error: "Error al crear." }); }
  });

  // ── Editar mecánico ─────────────────────────────────────────────────────────
  app.put("/admin/auxilio/mecanicos/:id", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const actual = await Mecanico.findUnique({ where: { id: req.params.id } });
      if (!actual) return res.status(404).json({ error: "Mecánico no encontrado." });

      const data = {};
      if (b.nombre != null) data.nombre = String(b.nombre).trim();
      if (b.telefono != null) {
        const tel = normalizarPhone(b.telefono);
        if (!tel) return res.status(400).json({ error: "Teléfono inválido." });
        if (tel !== actual.telefono) {
          const dup = await Mecanico.findUnique({ where: { telefono: tel } });
          if (dup) return res.status(409).json({ error: "Otro mecánico ya usa ese teléfono." });
        }
        data.telefono = tel;
      }
      if (b.zona != null) data.zona = String(b.zona).trim() || null;
      if (typeof b.lat === "number" && typeof b.lng === "number") data.ubicacionBase = { lat: b.lat, lng: b.lng };
      if (Array.isArray(b.tiposServicio)) data.tiposServicio = b.tiposServicio;
      if (b.atiende24h != null) data.atiende24h = !!b.atiende24h;
      if (b.documentos != null || b.facturaLuz != null || b.carnet != null || b.nit != null || b.verificacionFisica != null || b.notasVerificacion != null) {
        const doc = actual.documentos || {};
        data.documentos = {
          facturaLuz: b.facturaLuz != null ? !!b.facturaLuz : !!doc.facturaLuz,
          carnet: b.carnet != null ? !!b.carnet : !!doc.carnet,
          nit: b.nit != null ? (String(b.nit).trim() || null) : (doc.nit || null),
          verificacionFisica: b.verificacionFisica != null ? !!b.verificacionFisica : !!doc.verificacionFisica,
          notasVerificacion: b.notasVerificacion != null ? String(b.notasVerificacion) : (doc.notasVerificacion || null),
        };
      }
      if (b.suscripcionEstado != null || b.fechaVencimiento != null) {
        const sus = actual.suscripcion || {};
        const estado = ESTADOS_SUSCRIPCION.includes(b.suscripcionEstado) ? b.suscripcionEstado : (sus.estado || "mes_gratis");
        data.suscripcion = {
          estado,
          fechaInicio: sus.fechaInicio || new Date().toISOString(),
          fechaVencimiento: b.fechaVencimiento != null ? b.fechaVencimiento : (sus.fechaVencimiento || null),
        };
      }

      const mecanico = await Mecanico.update({ where: { id: req.params.id }, data });
      res.json({ ok: true, mecanico });
    } catch (e) { log.error("[AUXILIO_MEC_EDIT]", e.message); res.status(500).json({ error: "Error al editar." }); }
  });

  // ── Suspender / activar ─────────────────────────────────────────────────────
  app.post("/admin/auxilio/mecanicos/:id/suspender", async (req, res) => {
    if (!auth(req, res)) return;
    try { await Mecanico.update({ where: { id: req.params.id }, data: { activo: false } }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: "Error al suspender." }); }
  });
  app.post("/admin/auxilio/mecanicos/:id/activar", async (req, res) => {
    if (!auth(req, res)) return;
    try { await Mecanico.update({ where: { id: req.params.id }, data: { activo: true } }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: "Error al activar." }); }
  });

  // ── Lista de auxilios ───────────────────────────────────────────────────────
  app.get("/admin/auxilio/auxilios", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const where = {};
      if (req.query.estado && ESTADOS_AUXILIO.includes(req.query.estado)) where.estado = req.query.estado;
      const auxilios = await Auxilio.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { mecanico: true } });
      res.json({ auxilios });
    } catch (e) { log.error("[AUXILIO_LIST]", e.message); res.status(500).json({ error: "Error al listar auxilios." }); }
  });

  // ── Resumen ─────────────────────────────────────────────────────────────────
  app.get("/admin/auxilio/resumen", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const mecanicos = await Mecanico.findMany();
      const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
      const auxiliosMes = await Auxilio.count({ where: { createdAt: { gte: inicioMes } } });
      const est = (e) => mecanicos.filter(m => (m.suscripcion || {}).estado === e).length;
      const conCalif = mecanicos.filter(m => m.calificacionPromedio != null);
      const califProm = conCalif.length ? Math.round((conCalif.reduce((s, m) => s + m.calificacionPromedio, 0) / conCalif.length) * 10) / 10 : null;
      res.json({
        totalMecanicos: mecanicos.length,
        activos: mecanicos.filter(m => m.activo).length,
        mesGratis: est("mes_gratis"),
        suscripcionActiva: est("activa"),
        vencidos: est("vencida"),
        auxiliosMes,
        calificacionPromedio: califProm,
      });
    } catch (e) { log.error("[AUXILIO_RESUMEN]", e.message); res.status(500).json({ error: "Error en el resumen." }); }
  });

  // ── Panel HTML ──────────────────────────────────────────────────────────────
  app.get("/admin/auxilio", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PANEL);
  });
};

const PANEL = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c1310">
<link rel="icon" href="/logo.png">
<title>ChatGo — Auxilio Mecánico</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--verde:#1D9E75;--verde2:#34d399;--fondo:#0c1310;--card:#131c18;--card2:#0f1713;--borde:#1e2b24;--txt:#e7efe9;--gris:#7f948b;--rojo:#e5484d;--azul:#3b82f6;--amar:#fbbf24;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--fondo);color:var(--txt);min-height:100vh;padding-bottom:40px;}
  header{position:sticky;top:0;z-index:10;background:#0c1310ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--borde);padding:12px 16px;display:flex;align-items:center;gap:10px;}
  header img{width:30px;height:30px;border-radius:8px;} .h-t{font-size:15px;font-weight:800;} .h-t span{color:var(--verde2);}
  .wrap{max-width:1100px;margin:0 auto;padding:14px 16px;}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
  @media(max-width:640px){.kpis{grid-template-columns:repeat(2,1fr);}}
  .kpi{background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:11px;text-align:center;}
  .kpi .n{font-size:21px;font-weight:800;color:var(--verde2);} .kpi .l{font-size:9.5px;color:var(--gris);text-transform:uppercase;letter-spacing:.4px;margin-top:4px;}
  .tabs{display:flex;gap:8px;margin:16px 0 10px;}
  .tab{flex:1;background:var(--card);border:1px solid var(--borde);color:var(--gris);border-radius:10px;padding:10px;font-weight:800;font-size:14px;cursor:pointer;}
  .tab.act{background:linear-gradient(135deg,var(--verde2),var(--verde));color:#04140d;border-color:transparent;}
  .btn{background:var(--verde);color:#04140d;border:none;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;font-size:13px;}
  .btn.sec{background:transparent;border:1px solid var(--borde);color:var(--txt);}
  .btn.rojo{background:transparent;border:1px solid var(--rojo);color:var(--rojo);}
  .barra{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
  .card{background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:12px 14px;margin-bottom:9px;}
  .m-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .m-nom{font-size:15px;font-weight:700;}
  .tag{font-size:10px;padding:2px 8px;border-radius:6px;font-weight:700;}
  .tag.mes_gratis{background:#0e2a4a;color:#7fb2ff;} .tag.activa{background:#0e3a2a;color:var(--verde2);}
  .tag.vencida{background:#3a0a0a;color:#f87171;} .tag.suspendida{background:#2a2a0a;color:var(--amar);}
  .tag.off{background:#2a1215;color:#ffb4b4;} .tag.on{background:#0e3a2a;color:var(--verde2);}
  .m-sub{font-size:12px;color:var(--gris);margin-top:5px;line-height:1.5;}
  .m-acc{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
  .doc-ok{color:var(--verde2);} .doc-no{color:var(--rojo);}
  .aux{display:flex;justify-content:space-between;gap:10px;}
  .estado-p{color:var(--amar);} .estado-c{color:var(--verde2);} .estado-x{color:var(--rojo);}
  /* Modal */
  .modal{display:none;position:fixed;inset:0;background:rgba(4,8,6,.8);z-index:50;align-items:flex-start;justify-content:center;overflow:auto;padding:20px;}
  .modal.show{display:flex;}
  .m-form{background:var(--card);border:1px solid var(--borde);border-radius:16px;width:100%;max-width:520px;padding:20px;}
  .m-form h2{font-size:17px;margin-bottom:12px;}
  label{display:block;font-size:12px;color:var(--gris);margin:9px 0 3px;}
  input[type=text],input[type=number],textarea,select{width:100%;background:var(--card2);border:1px solid var(--borde);border-radius:9px;padding:9px 11px;color:var(--txt);font-size:14px;}
  .chks{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;}
  .chk{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--txt);}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .msg{font-size:12px;margin-top:8px;} .msg.err{color:var(--rojo);} .msg.ok{color:var(--verde2);}
  .m-btns{display:flex;gap:10px;margin-top:16px;}
</style>
</head>
<body>
<header>
  <img src="/logo.png" alt="ChatGo">
  <div class="h-t">ChatGo <span>· Auxilio Mecánico</span></div>
</header>
<div class="wrap">
  <div class="kpis" id="kpis"></div>
  <div class="tabs">
    <button class="tab act" id="tab-mec" onclick="verTab('mec')">🔧 Mecánicos</button>
    <button class="tab" id="tab-aux" onclick="verTab('aux')">🆘 Auxilios</button>
  </div>
  <div class="barra" id="barra-mec"><div style="font-weight:700">Mecánicos afiliados</div><button class="btn" onclick="abrirForm()">+ Agregar mecánico</button></div>
  <div id="lista-mec"></div>
  <div id="sec-aux" style="display:none"><div class="barra"><div style="font-weight:700">Auxilios solicitados</div></div><div id="lista-aux"></div></div>
</div>

<div class="modal" id="modal" onclick="if(event.target===this)cerrar()">
  <div class="m-form" id="m-form"></div>
</div>

<script>
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const SERVICIOS = ["llanta","bateria","mecanica_general","grua","cerrajeria"];
let MECS = [], editId = null;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(ruta, opts={}){
  const sep = ruta.includes("?") ? "&" : "?";
  const r = await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN), {method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});
  const d = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||"Error");
  return d;
}
async function cargar(){
  try{
    const res = await api("/admin/auxilio/resumen");
    document.getElementById("kpis").innerHTML =
      kpi(res.activos,"Activos")+kpi(res.mesGratis,"Mes gratis")+kpi(res.vencidos,"Vencidos")+kpi(res.auxiliosMes,"Auxilios del mes");
    const m = await api("/admin/auxilio/mecanicos"); MECS = m.mecanicos||[];
    pintarMec();
  }catch(e){ document.getElementById("kpis").innerHTML='<div class="kpi" style="grid-column:1/-1"><div class="n" style="color:var(--rojo);font-size:15px">'+esc(e.message)+'</div><div class="l">Revisá el token en la URL</div></div>'; }
}
function kpi(n,l){return '<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>';}
function pintarMec(){
  if(!MECS.length){ document.getElementById("lista-mec").innerHTML='<div class="card" style="color:var(--gris)">Todavía no hay mecánicos. Tocá "Agregar mecánico".</div>'; return; }
  document.getElementById("lista-mec").innerHTML = MECS.map(m=>{
    const sus=(m.suscripcion||{}).estado||"mes_gratis";
    const doc=m.documentos||{}; const docOk=doc.facturaLuz&&doc.carnet&&doc.verificacionFisica;
    const serv=(m.tiposServicio||[]).join(", ")||"—";
    return '<div class="card"><div class="m-top"><span class="m-nom">'+esc(m.nombre)+'</span>'+
      '<span class="tag '+sus+'">'+sus.replace("_"," ")+'</span>'+
      '<span class="tag '+(m.activo?"on":"off")+'">'+(m.activo?"activo":"suspendido")+'</span>'+
      (m.atiende24h?'<span class="tag activa">24h</span>':'')+'</div>'+
      '<div class="m-sub">📞 '+esc(m.telefono)+(m.zona?" · 📍 "+esc(m.zona):"")+'<br>'+
      '🔧 '+esc(serv)+'<br>'+
      '📄 Documentos: <span class="'+(docOk?"doc-ok":"doc-no")+'">'+(docOk?"completos":"incompletos")+'</span> · ⭐ '+(m.calificacionPromedio!=null?m.calificacionPromedio:"—")+' · Auxilios: '+(m.totalAuxilios||0)+'</div>'+
      '<div class="m-acc"><button class="btn sec" onclick="abrirForm(\\''+m.id+'\\')">Editar</button>'+
      (m.activo?'<button class="btn rojo" onclick="suspender(\\''+m.id+'\\')">Suspender</button>':'<button class="btn" onclick="activar(\\''+m.id+'\\')">Activar</button>')+'</div></div>';
  }).join("");
}
function verTab(t){
  document.getElementById("tab-mec").classList.toggle("act",t==="mec");
  document.getElementById("tab-aux").classList.toggle("act",t==="aux");
  document.getElementById("barra-mec").style.display=t==="mec"?"flex":"none";
  document.getElementById("lista-mec").style.display=t==="mec"?"block":"none";
  document.getElementById("sec-aux").style.display=t==="aux"?"block":"none";
  if(t==="aux") cargarAux();
}
async function cargarAux(){
  try{ const d=await api("/admin/auxilio/auxilios"); const a=d.auxilios||[];
    document.getElementById("lista-aux").innerHTML = a.length? a.map(x=>{
      const cl=x.estado==="completado"?"estado-c":(x.estado==="cancelado"?"estado-x":"estado-p");
      return '<div class="card"><div class="aux"><div><b>'+esc(x.tipoProblema||"—")+'</b><div class="m-sub">📞 '+esc(x.telefonoVarado)+(x.mecanico?" · 🔧 "+esc(x.mecanico.nombre):"")+'</div></div><div class="'+cl+'" style="font-weight:700">'+esc(x.estado)+'</div></div></div>';
    }).join("") : '<div class="card" style="color:var(--gris)">Todavía no hay auxilios registrados.</div>';
  }catch(e){ document.getElementById("lista-aux").innerHTML='<div class="card" style="color:var(--rojo)">'+esc(e.message)+'</div>'; }
}
function abrirForm(id){
  editId=id||null;
  const m = id ? MECS.find(x=>x.id===id) : {};
  const doc=m.documentos||{}, sus=m.suscripcion||{}, ub=m.ubicacionBase||{};
  const servSet=new Set(m.tiposServicio||[]);
  document.getElementById("m-form").innerHTML =
    '<h2>'+(id?"Editar mecánico":"Nuevo mecánico")+'</h2>'+
    '<label>Nombre *</label><input type="text" id="f-nombre" value="'+esc(m.nombre||"")+'">'+
    '<label>Teléfono (WhatsApp, 591...) *</label><input type="text" id="f-tel" value="'+esc(m.telefono||"")+'">'+
    '<label>Zona (Santa Cruz)</label><input type="text" id="f-zona" value="'+esc(m.zona||"")+'">'+
    '<div class="row2"><div><label>Lat (base)</label><input type="number" step="any" id="f-lat" value="'+(ub.lat??"")+'"></div><div><label>Lng (base)</label><input type="number" step="any" id="f-lng" value="'+(ub.lng??"")+'"></div></div>'+
    '<label>Servicios que hace</label><div class="chks">'+SERVICIOS.map(s=>'<label class="chk"><input type="checkbox" class="f-serv" value="'+s+'" '+(servSet.has(s)?"checked":"")+'> '+s.replace("_"," ")+'</label>').join("")+'</div>'+
    '<div class="chks" style="margin-top:8px"><label class="chk"><input type="checkbox" id="f-24h" '+(m.atiende24h?"checked":"")+'> Atiende 24h</label></div>'+
    '<label>Documentos</label><div class="chks"><label class="chk"><input type="checkbox" id="f-luz" '+(doc.facturaLuz?"checked":"")+'> Factura de luz</label><label class="chk"><input type="checkbox" id="f-carnet" '+(doc.carnet?"checked":"")+'> Carnet</label><label class="chk"><input type="checkbox" id="f-verif" '+(doc.verificacionFisica?"checked":"")+'> Verificación física</label></div>'+
    '<label>NIT (opcional)</label><input type="text" id="f-nit" value="'+esc(doc.nit||"")+'">'+
    '<label>Notas de verificación</label><textarea id="f-notas" rows="2">'+esc(doc.notasVerificacion||"")+'</textarea>'+
    '<label>Suscripción</label><select id="f-sus">'+["mes_gratis","activa","vencida","suspendida"].map(e=>'<option value="'+e+'" '+((sus.estado||"mes_gratis")===e?"selected":"")+'>'+e.replace("_"," ")+'</option>').join("")+'</select>'+
    '<div class="msg" id="f-msg"></div>'+
    '<div class="m-btns"><button class="btn" onclick="guardar()">Guardar</button><button class="btn sec" onclick="cerrar()">Cancelar</button></div>';
  document.getElementById("modal").classList.add("show");
}
function cerrar(){ document.getElementById("modal").classList.remove("show"); }
async function guardar(){
  const g=id=>document.getElementById(id);
  const body={
    nombre:g("f-nombre").value.trim(), telefono:g("f-tel").value.trim(), zona:g("f-zona").value.trim(),
    tiposServicio:[...document.querySelectorAll(".f-serv:checked")].map(c=>c.value),
    atiende24h:g("f-24h").checked, facturaLuz:g("f-luz").checked, carnet:g("f-carnet").checked,
    verificacionFisica:g("f-verif").checked, nit:g("f-nit").value.trim(), notasVerificacion:g("f-notas").value.trim(),
    suscripcionEstado:g("f-sus").value,
  };
  const lat=parseFloat(g("f-lat").value), lng=parseFloat(g("f-lng").value);
  if(!isNaN(lat)&&!isNaN(lng)){ body.lat=lat; body.lng=lng; }
  const msg=g("f-msg"); msg.className="msg"; msg.textContent="Guardando…";
  try{
    if(editId) await api("/admin/auxilio/mecanicos/"+editId,{method:"PUT",body});
    else await api("/admin/auxilio/mecanicos",{body});
    cerrar(); cargar();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
async function suspender(id){ if(!confirm("¿Suspender este mecánico?"))return; await api("/admin/auxilio/mecanicos/"+id+"/suspender",{method:"POST"}); cargar(); }
async function activar(id){ await api("/admin/auxilio/mecanicos/"+id+"/activar",{method:"POST"}); cargar(); }
cargar();
</script>
</body>
</html>`;
