// Envío del informe de evaluación por correo, desde el "correo padre"
// (VENTAS_MAIL_USER = rastreoplus@gmail.com) usando Gmail + contraseña de app.
const nodemailer = require("nodemailer");
const { CONFIG, log } = require("../config");

const DIMS = [
  ["tiempoRespuesta", "Tiempo de respuesta"], ["descubrimiento", "Descubrimiento de necesidad"],
  ["objeciones", "Manejo de objeciones"], ["seguimiento", "Seguimiento"],
  ["cierre", "Cierre"], ["cumplimiento", "Cumplimiento de promesas"],
];
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function col(s) { return s >= 7 ? "#2e7d32" : s >= 5 ? "#c07a00" : "#c0392b"; }

function construirHTML(ev, vendedor) {
  const a = ev.analisis || {};
  const fecha = new Date(ev.createdAt).toLocaleDateString("es-BO");
  const dims = DIMS.map(([k, n]) => {
    const s = ev[k] || 0;
    return `<tr><td style="padding:5px 0">${n}</td><td style="text-align:right;font-weight:700;color:${col(s)}">${s}/10</td></tr>`;
  }).join("");
  const lista = (arr, label, color) => (arr || []).map(x =>
    `<div style="margin:6px 0"><b style="color:${color}">${label}:</b> ${esc(x.texto)}<br><i style="color:#777">"${esc(x.cita)}"</i></div>`).join("");
  const prob = a.probabilidadCierre != null ? `<p style="font-size:20px;margin:10px 0"><b style="color:${a.probabilidadCierre >= 66 ? "#2e7d32" : a.probabilidadCierre >= 40 ? "#c07a00" : "#c0392b"}">${a.probabilidadCierre}%</b> <span style="color:#777;font-size:13px">probabilidad de cierre</span></p>` : "";
  const dinero = a.dineroPerdido ? `<p style="color:#c0392b"><b>Dinero potencial perdido:</b> Bs ${Number(a.dineroPerdido).toLocaleString("es-BO")}</p>` : "";
  const resumen = a.resumenEjecutivo ? `<p style="background:#f5f0e8;border-left:3px solid #c2703d;padding:10px"><b>Resumen ejecutivo:</b> ${esc(a.resumenEjecutivo)}</p>` : "";
  const mejora = ev.mejoraConcreta ? `<p style="background:#f5f0e8;border-left:3px solid #c2703d;padding:10px"><b>Mejora concreta:</b> ${esc(ev.mejoraConcreta)}</p>` : "";
  const alertas = (a.alertasRiesgo || []).map(x => `<p style="color:#b45309">⚠️ ${esc(x)}</p>`).join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#222">
    <div style="background:#c2703d;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <h2 style="margin:0">Informe de evaluación de ventas</h2>
      <div style="opacity:.9;font-size:14px">${esc(vendedor.nombre)}${vendedor.cargo ? " · " + esc(vendedor.cargo) : ""} — ${fecha}</div>
    </div>
    <div style="border:1px solid #e2d8cc;border-top:none;padding:18px 20px;border-radius:0 0 10px 10px">
      <p style="font-size:22px;margin:0"><b>Calificación general: <span style="color:${col(ev.promedio)}">${ev.promedio}</span>/10</b></p>
      ${prob}
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${dims}</table>
      ${lista(ev.fortalezas, "Fortaleza", "#2e7d32")}
      ${lista(ev.debilidades, "A mejorar", "#c0392b")}
      ${dinero}${alertas}${mejora}${resumen}
      <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
      <div style="text-align:center;color:#999;font-size:12px">Enviado por ChatGo — Evaluación de Ventas</div>
    </div>
  </div>`;
}

async function enviarInforme(destino, ev, vendedor) {
  if (!CONFIG.VENTAS_MAIL_PASS) throw new Error("Falta configurar el correo (VENTAS_MAIL_PASS, contraseña de aplicación de Gmail).");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: CONFIG.VENTAS_MAIL_USER, pass: CONFIG.VENTAS_MAIL_PASS },
  });
  await transporter.sendMail({
    from: `"ChatGo Evaluación" <${CONFIG.VENTAS_MAIL_USER}>`,
    to: destino,
    subject: `Informe de evaluación — ${vendedor.nombre} (${ev.promedio}/10)`,
    html: construirHTML(ev, vendedor),
  });
  log.info(`[VENTAS_MAIL] Informe enviado a ${destino} (vendedor ${vendedor.nombre})`);
}

module.exports = { enviarInforme };
