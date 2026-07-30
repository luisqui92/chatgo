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
        return { id: v.id, nombre: v.nombre, email: v.email, whatsapp: v.whatsapp, activo: v.activo, evaluaciones: n, promedio: prom };
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
      const v = await Vendedor.create({ data: { nombre, email, whatsapp: b.whatsapp ? String(b.whatsapp).trim() : null } });
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
      <h3>Agregar vendedor</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label>Nombre</label><input id="v-nom"></div>
        <div><label>Email (con el que reenvía)</label><input id="v-email"></div>
      </div>
      <label>WhatsApp (opcional)</label><input id="v-wa">
      <div style="margin-top:12px"><button class="btn" onclick="crearVend()">Agregar</button></div>
      <div class="msg" id="v-msg"></div>
    </div>
    <div id="lista-vend"></div>
    <div id="detalle-vend"></div>
  </div>
</div>
<footer><img src="/logo.png" alt=""> Powered by ChatGo</footer>
<script>
const TOKEN=new URLSearchParams(location.search).get("token")||"";
let VENDS=[];
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

async function crearVend(){
  const msg=document.getElementById("v-msg"); msg.className="msg"; msg.textContent="Guardando…";
  try{ await api("/ventas/vendedores",{body:{nombre:document.getElementById("v-nom").value,email:document.getElementById("v-email").value,whatsapp:document.getElementById("v-wa").value}});
    document.getElementById("v-nom").value=document.getElementById("v-email").value=document.getElementById("v-wa").value="";
    msg.className="msg ok"; msg.textContent="Vendedor agregado."; cargar(); cargarVends();
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
async function cargarVends(){
  try{ const d=await api("/ventas/vendedores"); VENDS=d.vendedores||[];
    document.getElementById("lista-vend").innerHTML='<div class="card"><h3>Vendedores</h3>'+(VENDS.length?VENDS.map(v=>
      '<div class="vrow" onclick="verDetalle(\\''+v.id+'\\')"><div class="vava">'+esc((v.nombre||"?")[0])+'</div><div class="vn"><b>'+esc(v.nombre)+'</b><div>'+esc(v.email)+' · '+v.evaluaciones+' evaluaciones</div></div><div class="score-big '+(v.promedio!=null?colScore(v.promedio):"")+'">'+(v.promedio!=null?v.promedio:"—")+'</div></div>'
    ).join(""):'<div style="color:var(--gr);padding:10px 0">Todavía no hay vendedores.</div>')+'</div>';
  }catch(e){}
}
async function verDetalle(id){
  const v=VENDS.find(x=>x.id===id);
  try{
    const d=await api("/ventas/evaluaciones?vendedorId="+id);
    const t=await api("/ventas/tendencia?vendedorId="+id).catch(()=>({movil:[]}));
    const evals=d.evaluaciones||[];
    let spark=""; if(t.movil&&t.movil.length>1){ spark='<div class="card"><h3>Tendencia (promedio móvil)</h3><div class="spark">'+t.movil.map(m=>'<div style="height:'+(m/10*100)+'%;background:'+barColor(m)+'"></div>').join("")+'</div></div>'; }
    document.getElementById("detalle-vend").innerHTML='<div class="card"><h3>'+esc(v.nombre)+'</h3><div style="color:var(--gr);font-size:12.5px">'+evals.length+' evaluaciones</div></div>'+spark+evals.map(e=>evalCard(e)).join("");
    document.getElementById("detalle-vend").scrollIntoView({behavior:"smooth"});
  }catch(e){ document.getElementById("detalle-vend").innerHTML='<div class="card" style="color:var(--rojo)">'+esc(e.message)+'</div>'; }
}
function evalCard(e){
  const dims=DIMS.map(function(p){var k=p[0],n=p[1];var s=e[k]||0;return '<div class="dim"><div class="top"><span class="n">'+n+'</span><span class="'+colScore(s)+'">'+s+'/10</span></div><div class="bar"><div style="width:'+(s*10)+'%;background:'+barColor(s)+'"></div></div></div>';}).join("");
  const forts=(e.fortalezas||[]).map(f=>'<div style="margin:7px 0"><span class="pill f">Fortaleza</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const debs=(e.debilidades||[]).map(f=>'<div style="margin:7px 0"><span class="pill d">A mejorar</span> '+esc(f.texto)+'<div class="cita">"'+esc(f.cita)+'"</div></div>').join("");
  const fecha=new Date(e.createdAt).toLocaleDateString("es-BO");
  return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Evaluación · '+fecha+'</h3><span class="score-big '+colScore(e.promedio)+'">'+e.promedio+'</span></div>'+dims+forts+debs+(e.mejoraConcreta?'<div class="mejora"><b>Mejora concreta:</b> '+esc(e.mejoraConcreta)+'</div>':'')+'</div>';
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
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||"Error");
    msg.className="msg ok"; msg.textContent="Evaluación lista y guardada.";
    document.getElementById("e-resultado").innerHTML=evalCard(d.evaluacion);
  }catch(e){ msg.className="msg err"; msg.textContent=e.message; }
}
cargar();
</script></body></html>`;
