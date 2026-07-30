// Sistema de Evaluación de Ventas por WhatsApp — panel + API.
// SEPARADO de ChatGo: solo reusa el servidor Express y la base MySQL.
//
//   GET  /ventas                         → panel HTML
//   GET  /ventas/rubro                   → rubro (auditable)
//   GET  /ventas/vendedores              → vendedores + promedio
//   POST /ventas/vendedores              → crear vendedor
//   GET  /ventas/evaluaciones?vendedorId → evaluaciones de un vendedor
//   POST /ventas/evaluar                 → evaluar una conversación con Claude (en vivo)
//   GET  /ventas/tendencia?vendedorId&n  → promedio móvil de las últimas N
//
// Protegido con VENTAS_ADMIN_TOKEN (token propio, separado de ChatGo).

const crypto = require("crypto");
const multer = require("multer");
const { CONFIG, log } = require("../config");
const { Vendedor, EvaluacionVenta } = require("../db/models");
const RUBRO = require("../config/rubro_ventas");
const { evaluarConversacion } = require("../services/ventas_scoring");
const { extraerTextoDeArchivo } = require("../services/ventas_extraer");

const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const MAP = { tiempo_respuesta: "tiempoRespuesta", descubrimiento: "descubrimiento", objeciones: "objeciones", seguimiento: "seguimiento", cierre: "cierre", cumplimiento: "cumplimiento" };

module.exports = function (app) {
  function auth(req, res) {
    const token = String(req.query.token || "");
    const esperado = CONFIG.VENTAS_ADMIN_TOKEN || "";
    let ok = false;
    if (esperado && token.length === esperado.length) {
      try { ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado)); } catch (_) {}
    }
    if (!ok) { res.status(401).json({ error: "No autorizado" }); return false; }
    return true;
  }

  app.get("/ventas/rubro", (req, res) => { if (!auth(req, res)) return; res.json(RUBRO); });

  app.get("/ventas/vendedores", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vends = await Vendedor.findMany({ orderBy: { nombre: "asc" }, include: { evaluaciones: { select: { promedio: true } } } });
      const out = vends.map(v => {
        const n = v.evaluaciones.length;
        const prom = n ? Math.round((v.evaluaciones.reduce((s, e) => s + e.promedio, 0) / n) * 10) / 10 : null;
        return { id: v.id, nombre: v.nombre, email: v.email, whatsapp: v.whatsapp, telefono: v.telefono, cargo: v.cargo, zona: v.zona, foto: v.foto, fechaIngreso: v.fechaIngreso, activo: v.activo, evaluaciones: n, promedio: prom };
      });
      res.json({ vendedores: out });
    } catch (e) { log.error("[VENTAS_VEND]", e.message); res.status(500).json({ error: "Error al listar." }); }
  });

  app.post("/ventas/vendedores", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const nombre = String(b.nombre || "").trim();
      const email = String(b.email || "").trim().toLowerCase();
      if (!nombre) return res.status(400).json({ error: "El nombre es requerido." });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Email inválido." });
      const dup = await Vendedor.findUnique({ where: { email } });
      if (dup) return res.status(409).json({ error: "Ya existe un vendedor con ese email." });
      let foto = null;
      if (typeof b.foto === "string" && b.foto.startsWith("data:image") && b.foto.length < 900000) foto = b.foto;
      const v = await Vendedor.create({ data: {
        nombre, email,
        whatsapp: b.whatsapp ? String(b.whatsapp).trim() : null,
        telefono: b.telefono ? String(b.telefono).trim() : null,
        cargo: b.cargo ? String(b.cargo).trim() : null,
        zona: b.zona ? String(b.zona).trim() : null,
        foto,
        fechaIngreso: b.fechaIngreso ? new Date(b.fechaIngreso) : null,
      } });
      res.json({ ok: true, vendedor: v });
    } catch (e) { log.error("[VENTAS_VEND_CREATE]", e.message); res.status(500).json({ error: "Error al crear." }); }
  });

  app.get("/ventas/evaluaciones", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const where = req.query.vendedorId ? { vendedorId: String(req.query.vendedorId) } : {};
      const evals = await EvaluacionVenta.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
      res.json({ evaluaciones: evals });
    } catch (e) { res.status(500).json({ error: "Error al listar evaluaciones." }); }
  });

  // Evaluar una conversación pegada (scoring en vivo con Claude) — con evidencia
  app.post("/ventas/evaluar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const b = req.body || {};
      const vendedor = await Vendedor.findUnique({ where: { id: String(b.vendedorId || "") } });
      if (!vendedor) return res.status(400).json({ error: "Elegí un vendedor válido." });
      const conversacion = String(b.conversacion || "");

      const ev = await evaluarConversacion(conversacion, vendedor.id); // valida cita o lanza error

      const data = {
        vendedorId: vendedor.id,
        fechaConversacion: b.fechaConversacion ? new Date(b.fechaConversacion) : new Date(),
        promedio: ev.promedio,
        fortalezas: ev.fortalezas, debilidades: ev.debilidades,
        mejoraConcreta: ev.mejora_concreta, conversacion: conversacion.slice(0, 20000),
        analisis: ev.analisis || null,
      };
      for (const k of Object.keys(MAP)) data[MAP[k]] = ev.scores[k];
      const guardada = await EvaluacionVenta.create({ data });
      res.json({ ok: true, evaluacion: guardada });
    } catch (e) {
      log.error("[VENTAS_EVALUAR]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // Evaluar desde un ARCHIVO subido (zip/rar/txt/audio) — sin copiar y pegar
  app.post("/ventas/evaluar-archivo", subir.single("archivo"), async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vendedor = await Vendedor.findUnique({ where: { id: String((req.body && req.body.vendedorId) || "") } });
      if (!vendedor) return res.status(400).json({ error: "Elegí un vendedor válido." });
      if (!req.file) return res.status(400).json({ error: "Subí el archivo del chat (ZIP, RAR, TXT o audio)." });

      let conversacion = "";
      try {
        conversacion = await extraerTextoDeArchivo(req.file.buffer, req.file.originalname, req.file.mimetype);
      } catch (e) { return res.status(422).json({ error: e.message }); }
      if (!conversacion || conversacion.trim().length < 20) {
        return res.status(422).json({ error: "No pude leer una conversación válida del archivo. Revisá que sea el chat exportado (o un audio claro)." });
      }

      const ev = await evaluarConversacion(conversacion, vendedor.id);
      const data = {
        vendedorId: vendedor.id, fechaConversacion: new Date(), promedio: ev.promedio,
        fortalezas: ev.fortalezas, debilidades: ev.debilidades,
        mejoraConcreta: ev.mejora_concreta, conversacion: conversacion.slice(0, 20000),
        analisis: ev.analisis || null,
      };
      for (const k of Object.keys(MAP)) data[MAP[k]] = ev.scores[k];
      const guardada = await EvaluacionVenta.create({ data });
      res.json({ ok: true, evaluacion: guardada });
    } catch (e) {
      log.error("[VENTAS_EVAL_ARCHIVO]", e.message);
      res.status(422).json({ error: e.message });
    }
  });

  // Promedio móvil de las últimas N evaluaciones (tendencia)
  app.get("/ventas/tendencia", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const vendedorId = String(req.query.vendedorId || "");
      const n = Math.min(Math.max(parseInt(req.query.n) || 10, 2), 50);
      if (!vendedorId) return res.status(400).json({ error: "Falta vendedorId." });
      const evals = await EvaluacionVenta.findMany({ where: { vendedorId }, orderBy: { createdAt: "asc" }, take: 200 });
      const serie = evals.map(e => e.promedio);
      // promedio móvil simple de ventana n
      const movil = serie.map((_, i) => {
        const ini = Math.max(0, i - n + 1); const w = serie.slice(ini, i + 1);
        return Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10;
      });
      res.json({ serie, movil, ventana: n });
    } catch (e) { res.status(500).json({ error: "Error en la tendencia." }); }
  });

  app.get("/ventas", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(PANEL);
  });
};

const PANEL = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#17110d"><link rel="icon" href="/logo.png">
<title>Evaluación de Ventas</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  :root{--acc:#c26e3d;--acc2:#e2965a;--bg:#17110d;--card:#221a13;--card2:#1a130d;--bd:#3a2e22;--tx:#f1e8dd;--gr:#a8968a;--rojo:#d9705a;--amar:#d9a441;--verde:#7fa662;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Georgia,serif;background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:30px;}
  header{position:sticky;top:0;z-index:10;background:#17110de8;backdrop-filter:blur(6px);border-bottom:1px solid var(--bd);padding:13px 18px;display:flex;align-items:center;gap:11px;}
  header img{width:32px;height:32px;border-radius:8px;}
  .h-t{font-size:16px;font-weight:700;letter-spacing:.2px;} .h-t span{color:var(--acc2);}
  .wrap{max-width:1000px;margin:0 auto;padding:16px 18px;}
  .tabs{display:flex;gap:8px;margin-bottom:14px;}
  .tab{flex:1;background:var(--card);border:1px solid var(--bd);color:var(--gr);border-radius:10px;padding:11px;font-weight:700;font-size:14px;cursor:pointer;}
  .tab.act{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#fff;border-color:transparent;}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:12px;}
  .card h3{font-size:15px;font-weight:700;margin-bottom:6px;}
  .btn{background:var(--acc);color:#fff;border:none;border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px;}
  .btn.sec{background:transparent;border:1px solid var(--bd);color:var(--tx);}
  label{display:block;font-size:12.5px;color:var(--gr);margin:10px 0 4px;}
  input,select{width:100%;background:var(--card2);border:1px solid var(--bd);border-radius:9px;padding:10px 12px;color:var(--tx);font-size:14px;}
  .file{border:1.5px dashed var(--bd);border-radius:11px;padding:16px;text-align:center;background:var(--card2);cursor:pointer;}
  .file:hover{border-color:var(--acc);}
  .file input{display:none;}
  .file .ic{font-size:22px;} .file .t{font-weight:700;margin-top:6px;font-size:14px;} .file .s{font-size:12px;color:var(--gr);margin-top:3px;}
  .file .sel{color:var(--acc2);font-weight:700;margin-top:8px;font-size:13px;}
  .avup{width:72px;height:72px;border-radius:50%;border:2px dashed var(--bd);background:var(--card2);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--gr);font-size:20px;text-align:center;line-height:1.1;flex-shrink:0;overflow:hidden;}
  .avup:hover{border-color:var(--acc);}
  .prob{display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,#2a1c12,#221812);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;margin:10px 0;}
  .prob .p{font-size:30px;font-weight:800;} .prob .lbl{font-size:12px;color:var(--gr);}
  .fac{font-size:12.5px;margin:3px 0;} .fac .ok{color:var(--verde);} .fac .rg{color:var(--amar);}
  .emo{display:inline-block;font-size:12px;background:#2a2015;border:1px solid var(--bd);border-radius:20px;padding:3px 11px;font-weight:600;}
  .rideal{background:#241a12;border:1px solid var(--bd);border-radius:10px;padding:11px;margin-top:10px;font-size:12.5px;}
  .rideal .lbl{color:var(--acc2);font-weight:700;} .rideal .cur{color:var(--gr);} .rideal .id{color:var(--verde);}
  .alerta{background:#331a12;border:1px solid #6b3a24;color:#f0b090;border-radius:9px;padding:8px 11px;margin-top:7px;font-size:12.5px;}
  .dinero{color:var(--rojo);font-weight:800;}
  .comp{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12.5px;} .comp .n{width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} .comp .b{flex:1;height:9px;background:#241a11;border-radius:5px;overflow:hidden;} .comp .b>div{height:100%;} .comp .v{width:34px;text-align:right;font-weight:700;}
  .vrow{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #241a11;cursor:pointer;}
  .vrow:hover{opacity:.9;}
  .vava{width:36px;height:36px;border-radius:50%;background:#2e2116;display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--acc2);flex-shrink:0;}
  .vn{flex:1;} .vn b{font-size:14px;} .vn div{font-size:11.5px;color:var(--gr);margin-top:1px;}
  .score-big{font-size:21px;font-weight:800;} .sc-hi{color:var(--verde);} .sc-mid{color:var(--amar);} .sc-lo{color:var(--rojo);}
  .dim{margin:9px 0;} .dim .top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;} .dim .n{font-weight:600;}
  .bar{height:8px;border-radius:5px;background:#241a11;overflow:hidden;} .bar>div{height:100%;border-radius:5px;}
  .cita{font-size:12.5px;color:var(--gr);font-style:italic;border-left:2px solid var(--acc);padding-left:9px;margin-top:3px;}
  .pill{font-size:11px;padding:2px 9px;border-radius:6px;font-weight:700;}
  .pill.f{background:#2a2915;color:#c9d18a;} .pill.d{background:#2f1c15;color:#e5a690;}
  .msg{font-size:13px;margin-top:10px;} .msg.err{color:var(--rojo);} .msg.ok{color:var(--verde);}
  .mejora{background:#2a2015;border:1px solid var(--bd);border-radius:10px;padding:11px 13px;margin-top:11px;font-size:13.5px;}
  .mejora b{color:var(--acc2);}
  .spark{display:flex;align-items:flex-end;gap:3px;height:46px;margin-top:10px;} .spark>div{flex:1;border-radius:3px 3px 0 0;min-height:3px;}
  footer{text-align:center;color:var(--gr);font-size:12px;margin-top:24px;display:flex;align-items:center;justify-content:center;gap:7px;}
  footer img{width:16px;height:16px;border-radius:4px;opacity:.9;}
</style></head><body>
<header><img src="/logo.png" alt="ChatGo"><div class="h-t">Evaluación de <span>Ventas</span></div></header>
<div class="wrap">
  <div class="tabs">
    <button class="tab act" id="t-eval" onclick="verTab('eval')">Evaluación</button>
    <button class="tab" id="t-vend" onclick="verTab('vend')">Vendedores</button>
  </div>

  <div id="sec-eval">
    <div class="card">
      <h3>Nueva evaluación</h3>
      <label>Vendedor</label><select id="e-vend"></select>
      <label>Archivo del chat exportado</label>
      <label class="file" for="e-file" id="file-box">
        <div class="ic">📎</div>
        <div class="t">Subí el archivo</div>
        <div class="s">Formatos: ZIP · RAR · TXT · audio</div>
        <div class="sel" id="file-sel"></div>
        <input type="file" id="e-file" accept=".zip,.rar,.txt,audio/*,.opus,.ogg,.mp3,.m4a" onchange="mostrarArchivo()">
      </label>
      <div style="margin-top:12px"><button class="btn" onclick="evaluar()">Evaluar</button></div>
      <div class="msg" id="e-msg"></div>
    </div>
    <div id="e-resultado"></div>
  </div>

  <div id="sec-vend" style="display:none">
    <div class="card">
      <h3>Nuevo vendedor</h3>
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:4px">
        <label class="avup" for="v-foto">
          <span id="v-foto-ph">＋<br><span style="font-size:10px">Foto</span></span>
          <img id="v-foto-img" style="display:none;width:100%;height:100%;object-fit:cover">
          <input type="file" id="v-foto" accept="image/*" style="display:none" onchange="cargarFoto()">
        </label>
        <div style="flex:1"><label>Nombre completo</label><input id="v-nom"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Cargo</label><input id="v-cargo" placeholder="Ej: Asesor comercial"></div>
        <div><label>Zona</label><input id="v-zona" placeholder="Ej: Cochabamba"></div>
        <div><label>Email (con el que reenvía)</label><input id="v-email"></div>
        <div><label>WhatsApp</label><input id="v-wa"></div>
        <div><label>Teléfono</label><input id="v-tel"></div>
        <div><label>Fecha de ingreso</label><input id="v-fecha" type="date"></div>
      </div>
      <div style="margin-top:12px"><button class="btn" onclick="crearVend()">Agregar vendedor</button></div>
      <div class="msg" id="v-msg"></div>
    </div>
    <div id="lista-vend"></div>
    <div id="detalle-vend"></div>
  </div>
</div>
<footer><img src="/logo.png" alt=""> Powered by ChatGo</footer>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let VENDS=[], FOTO_B64=null;
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(ruta,opts={}){const sep=ruta.includes("?")?"&":"?";const r=await fetch(ruta+sep+"token="+encodeURIComponent(TOKEN),{method:opts.method||(opts.body?"POST":"GET"),headers:{"Content-Type":"application/json"},body:opts.body?JSON.stringify(opts.body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Error");return d;}
function colScore(s){return s>=7?"sc-hi":s>=5?"sc-mid":"sc-lo";}
function barColor(s){return s>=7?"#7fa662":s>=5?"#d9a441":"#d9705a";}
const DIMS=[["tiempoRespuesta","Tiempo de respuesta"],["descubrimiento","Descubrimiento de necesidad"],["objeciones","Manejo de objeciones"],["seguimiento","Seguimiento"],["cierre","Cierre"],["cumplimiento","Cumplimiento de promesas"]];

function verTab(t){
  document.getElementById("t-eval").classList.toggle("act",t==="eval");
  document.getElementById("t-vend").classList.toggle("act",t==="vend");
  document.getElementById("sec-eval").style.display=t==="eval"?"block":"none";
  document.getElementById("sec-vend").style.display=t==="vend"?"block":"none";
  if(t==="vend") cargarVends();
}
async function cargar(){ try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[]; llenarSelect(); }catch(e){ const m=document.getElementById("e-msg"); m.className="msg err"; m.textContent=e.message+" (revisá el token)"; } }
function llenarSelect(){ document.getElementById("e-vend").innerHTML=VENDS.length?VENDS.map(v=>'<option value="'+v.id+'">'+esc(v.nombre)+'</option>').join(""):'<option value="">— agregá un vendedor primero —</option>'; }
function mostrarArchivo(){ const f=document.getElementById("e-file").files[0]; document.getElementById("file-sel").textContent=f?("Seleccionado: "+f.name):""; }

function cargarFoto(){
  const f=document.getElementById("v-foto").files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=e=>{ const img=new Image(); img.onload=()=>{ const c=document.createElement("canvas"); const S=256; c.width=S;c.height=S; const ctx=c.getContext("2d"); const m=Math.min(img.width,img.height); ctx.drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,S,S); FOTO_B64=c.toDataURL("image/jpeg",0.82); const im=document.getElementById("v-foto-img"); im.src=FOTO_B64; im.style.display="block"; document.getElementById("v-foto-ph").style.display="none"; }; img.src=e.target.result; };
  rd.readAsDataURL(f);
}
async function crearVend(){
  const g=id=>document.getElementById(id).value;
  const msg=document.getElementById("v-msg"); msg.className="msg"; msg.textContent="Guardando…";
  try{ await api("/ventas/vendedores",{body:{nombre:g("v-nom"),email:g("v-email"),whatsapp:g("v-wa"),telefono:g("v-tel"),cargo:g("v-cargo"),zona:g("v-zona"),fechaIngreso:g("v-fecha")||null,foto:FOTO_B64}});
    ["v-nom","v-email","v-wa","v-tel","v-cargo","v-zona","v-fecha"].forEach(i=>document.getElementById(i).value="");
    FOTO_B64=null; document.getElementById("v-foto-img").style.display="none"; document.getElementById("v-foto-ph").style.display="block";
    msg.className="msg ok"; msg.textContent="Vendedor agregado."; cargar(); cargarVends();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
async function cargarVends(){
  try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[];
    document.getElementById("lista-vend").innerHTML='<div class="card"><h3>Vendedores</h3>'+(VENDS.length?VENDS.map(v=>
      '<div class="vrow" onclick="verDetalle(\\''+v.id+'\\')"><div class="vava">'+(v.foto?'<img src="'+v.foto+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':esc((v.nombre||"?")[0]))+'</div><div class="vn"><b>'+esc(v.nombre)+'</b><div>'+(v.cargo?esc(v.cargo)+' · ':'')+v.evaluaciones+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div>'
    ).join(""):'<div style="color:var(--gr);padding:10px 0">Todavía no hay vendedores.</div>')+'</div>';
  }catch(e){}
}
async function verDetalle(id){
  const v=VENDS.find(x=>x.id===id);
  try{
    const d=await api("/ventas/evaluaciones?vendedorId="+id);
    const t=await api("/ventas/tendencia?vendedorId="+id).catch(()=>({movil:[]}));
    const evals=d.evaluaciones||[];
    // Cabecera con foto y datos
    const av=v.foto?'<img src="'+v.foto+'" style="width:56px;height:56px;border-radius:50%;object-fit:cover">':'<div class="vava" style="width:56px;height:56px;font-size:22px">'+esc((v.nombre||"?")[0])+'</div>';
    const meta=[v.cargo,v.zona,v.email].filter(Boolean).map(esc).join(" · ");
    const header='<div class="card"><div style="display:flex;align-items:center;gap:14px">'+av+'<div style="flex:1"><h3 style="margin:0">'+esc(v.nombre)+'</h3><div style="color:var(--gr);font-size:12.5px;margin-top:2px">'+meta+'</div><div style="color:var(--gr);font-size:12px;margin-top:2px">'+evals.length+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div></div>';
    // Comparación con el equipo
    const conProm=VENDS.filter(x=>x.promedio!=null);
    let comp="";
    if(conProm.length>1 && v.promedio!=null){
      const avgEmp=Math.round((conProm.reduce((s,x)=>s+x.promedio,0)/conProm.length)*10)/10;
      const orden=[...conProm].sort((a,b)=>b.promedio-a.promedio); const mejor=orden[0];
      const barras=orden.slice(0,5).map(x=>'<div class="comp"><span class="n" style="'+(x.id===id?"color:var(--acc2);font-weight:700":"")+'">'+esc(x.nombre)+'</span><span class="b"><div style="width:'+(x.promedio/10*100)+'%;background:'+barColor(x.promedio)+'"></div></span><span class="v">'+x.promedio+'</span></div>').join("");
      let gap=""; if(mejor.id!==id){ const pct=Math.round((mejor.promedio-v.promedio)/mejor.promedio*100); gap='<div style="margin-top:8px;font-size:13px">Estás un <b class="sc-lo">'+pct+'% por debajo</b> del mejor vendedor ('+esc(mejor.nombre)+').</div>'; }
      else gap='<div style="margin-top:8px;font-size:13px"><b class="sc-hi">Sos el mejor vendedor del equipo.</b> 👏</div>';
      comp='<div class="card"><h3>Comparación con el equipo</h3><div style="font-size:12.5px;color:var(--gr);margin-bottom:8px">Promedio empresa: <b style="color:var(--tx)">'+avgEmp+'</b></div>'+barras+gap+'</div>';
    }
    let spark=""; if(t.movil&&t.movil.length>1){ spark='<div class="card"><h3>Evolución (promedio móvil)</h3><div class="spark">'+t.movil.map(m=>'<div style="height:'+(m/10*100)+'%;background:'+barColor(m)+'"></div>').join("")+'</div></div>'; }
    document.getElementById("detalle-vend").innerHTML=header+comp+spark+evals.map(e=>evalCard(e)).join("");
    document.getElementById("detalle-vend").scrollIntoView({behavior:"smooth"});
  }catch(e){ document.getElementById("detalle-vend").innerHTML='<div class="card" style="color:var(--rojo)">'+esc(e.message)+'</div>'; }
}
function evalCard(e){
  const dims=DIMS.map(function(p){var k=p[0],n=p[1];var s=e[k]||0;return '<div class="dim"><div class="top"><span class="n">'+n+'</span><span class="'+colScore(s)+'">'+s+'/10</span></div><div class="bar"><div style="width:'+(s*10)+'%;background:'+barColor(s)+'"></div></div></div>';}).join("");
  const forts=(e.fortalezas||[]).map(f=>'<div style="margin:7px 0"><span class="pill f">Fortaleza</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const debs=(e.debilidades||[]).map(f=>'<div style="margin:7px 0"><span class="pill d">A mejorar</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const fecha=new Date(e.createdAt).toLocaleDateString("es-BO");
  const a=e.analisis||{};
  const EMO={entusiasmado:"😊 Entusiasmado",indeciso:"😐 Indeciso",molesto:"😠 Molesto",perdido:"😴 Perdió interés",neutral:"🙂 Neutral"};
  let prob=""; if(a.probabilidadCierre!=null){ const c=a.probabilidadCierre>=66?"sc-hi":a.probabilidadCierre>=40?"sc-mid":"sc-lo"; const facs=(a.factores||[]).map(f=>'<div class="fac"><span class="'+(f.tipo==="riesgo"?"rg":"ok")+'">'+(f.tipo==="riesgo"?"⚠":"✓")+'</span> '+esc(f.texto)+'</div>').join(""); prob='<div class="prob"><div><div class="p '+c+'">'+a.probabilidadCierre+'%</div><div class="lbl">prob. de cierre</div></div><div style="flex:1">'+facs+'</div></div>'; }
  let emo=""; if(a.emocionCliente){ emo='<div style="margin:8px 0"><span class="emo">Cliente: '+(EMO[a.emocionCliente]||esc(a.emocionCliente))+'</span>'+((a.emocionEvolucion&&a.emocionEvolucion.length>1)?' <span style="color:var(--gr);font-size:11.5px">('+a.emocionEvolucion.map(x=>(EMO[x]||x).replace(/^\\S+\\s/,"")).join(" → ")+')</span>':'')+'</div>'; }
  let dinero=""; if(a.dineroPerdido){ dinero='<div style="margin-top:8px;font-size:13px">💸 Dinero potencial perdido: <span class="dinero">Bs '+Number(a.dineroPerdido).toLocaleString("es-BO")+'</span></div>'; }
  let ideal=""; if(a.respuestaIdeal&&a.respuestaIdeal.respuesta_ideal){ const r=a.respuestaIdeal; ideal='<div class="rideal"><div class="lbl">Respuesta recomendada'+(r.situacion?' — '+esc(r.situacion):'')+'</div>'+(r.respuesta_actual?'<div class="cur" style="margin-top:4px">Respondió: "'+esc(r.respuesta_actual)+'"</div>':'')+'<div class="id" style="margin-top:4px">Ideal: "'+esc(r.respuesta_ideal)+'"</div></div>'; }
  let alertas=(a.alertasRiesgo||[]).map(x=>'<div class="alerta">⚠️ '+esc(x)+'</div>').join("");
  let resumen=a.resumenEjecutivo?'<div class="mejora" style="background:#221a12"><b>Resumen ejecutivo:</b> '+esc(a.resumenEjecutivo)+'</div>':'';
  return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Evaluación · '+fecha+'</h3><span class="score-big '+colScore(e.promedio)+'">'+e.promedio+'</span></div>'+prob+emo+dims+forts+debs+dinero+ideal+alertas+(e.mejoraConcreta?'<div class="mejora"><b>Mejora concreta:</b> '+esc(e.mejoraConcreta)+'</div>':'')+resumen+'</div>';
}
async function evaluar(){
  const msg=document.getElementById("e-msg"); const vid=document.getElementById("e-vend").value; const file=document.getElementById("e-file").files[0];
  if(!vid){ msg.className="msg err"; msg.textContent="Agregá y elegí un vendedor primero."; return; }
  if(!file){ msg.className="msg err"; msg.textContent="Subí el archivo del chat (ZIP, RAR, TXT o audio)."; return; }
  msg.className="msg"; msg.textContent="Evaluando… (puede tardar unos segundos)";
  document.getElementById("e-resultado").innerHTML="";
  try{
    const fd=new FormData(); fd.append("vendedorId",vid); fd.append("archivo",file);
    const r=await fetch("/ventas/evaluar-archivo?token="+encodeURIComponent(TOKEN),{method:"POST",body:fd});
    let d={}; try{ d=await r.json(); }catch(_){}
    if(!r.ok){ if(r.status===413) throw new Error("El archivo es muy grande para el servidor. Hay que subir el límite de nginx (client_max_body_size)."); throw new Error(d.error||("Error "+r.status)); }
    msg.className="msg ok"; msg.textContent="Evaluación lista y guardada.";
    document.getElementById("e-resultado").innerHTML=evalCard(d.evaluacion);
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
cargar();
</script></body></html>`;
