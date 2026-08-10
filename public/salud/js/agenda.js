// Vitalis — Agenda: citas del médico (manuales + las que llegan solas por
// WhatsApp), y configuración del horario de atención / calendario de Google.

const ORIGEN_ICONO = { whatsapp: "💬", manual: "🖊️" };
const DIAS_SEMANA_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

async function renderAgenda() {
  detenerPolling();
  app.innerHTML = `<div class="loading">⏳ Cargando agenda...</div>`;
  try {
    const [dataCitas, dataPacientes, dataWA] = await Promise.all([
      api("/medico/citas"),
      api("/medico/pacientes"),
      api("/medico/whatsapp/estado"),
    ]);
    pintarAgenda(dataCitas.citas || [], dataPacientes.pacientes || [], dataWA);
  } catch (e) {
    if (e.status === 401) return logout();
    app.innerHTML = `<div class="error">${esc(e.error || "Error cargando la agenda")}</div>`;
  }
}

function whatsappCardHtml(wa) {
  if (!wa || !wa.configurado) {
    return `
      <div class="card">
        <div class="seccion-titulo" style="margin-top:0">💬 WhatsApp de reservas</div>
        <div class="hint">Todavía no está configurado. Podés seguir usando la Agenda a mano mientras tanto.</div>
      </div>`;
  }
  if (wa.conectado) {
    return `
      <div class="card">
        <div class="seccion-titulo" style="margin-top:0">💬 WhatsApp de reservas</div>
        <div class="hint" style="color:var(--success)">✅ Conectado — los pacientes ya pueden reservar por WhatsApp.</div>
        <button class="link" id="btnReiniciarWA" style="color:var(--danger)">Vincular otro número</button>
      </div>`;
  }
  if (wa.qr) {
    return `
      <div class="card" style="text-align:center">
        <div class="seccion-titulo" style="margin-top:0;text-align:left">💬 WhatsApp de reservas</div>
        <div class="hint" style="margin-bottom:10px">Escaneá este código con el WhatsApp que vas a usar para las reservas: abrí WhatsApp → Dispositivos vinculados → Vincular un dispositivo.</div>
        <img src="${wa.qr}" style="width:220px;max-width:100%;border-radius:8px">
      </div>`;
  }
  return `<div class="card"><div class="seccion-titulo" style="margin-top:0">💬 WhatsApp de reservas</div><div class="hint">Conectando...</div></div>`;
}

function pintarAgenda(citas, pacientes, wa) {
  const pendientes = citas.filter(c => c.estado === "confirmada");
  app.innerHTML = `
    <button class="back" id="btnBack">← Panel</button>
    ${whatsappCardHtml(wa)}
    <button class="secondary" id="btnNuevaCita">➕ Nueva cita</button>
    <button class="link" id="btnConfigHorario">⚙️ Configurar horario de atención</button>

    <div id="citaFormBox" style="display:none;margin-top:12px" class="card">
      <div class="seccion-titulo" style="margin-top:0">Nueva cita</div>
      <label>Paciente registrado (opcional)</label>
      <select id="citaPacienteId">
        <option value="">— Paciente nuevo / sin registrar —</option>
        ${pacientes.map(p => `<option value="${p._id}">${esc(p.nombre)}</option>`).join("")}
      </select>
      <label>Nombre (si no es un paciente registrado)</label>
      <input id="citaNombre" type="text" placeholder="Nombre completo">
      <label>Teléfono (opcional)</label>
      <input id="citaTelefono" type="tel" placeholder="591XXXXXXXX">
      <label>Fecha y hora</label>
      <input id="citaFecha" type="datetime-local">
      <label>Motivo (opcional)</label>
      <input id="citaMotivo" type="text" placeholder="Ej: Control">
      <div id="citaErr"></div>
      <button class="secondary" id="btnGuardarCita">Guardar cita</button>
    </div>

    ${pendientes.length === 0 ? `<div class="empty" style="margin-top:14px">No hay citas próximas.</div>` : ""}
    ${pendientes.map(c => `
      <div class="item" style="cursor:default;margin-top:10px">
        <div class="top">
          <div class="nombre">${ORIGEN_ICONO[c.origen] || ""} ${esc(c.pacienteNombre)}</div>
          <button class="link" data-cancelar-cita="${c._id}" style="margin:0;width:auto;color:var(--danger)">Cancelar</button>
        </div>
        <div class="fecha">${new Date(c.fecha).toLocaleString("es-BO", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
        ${c.motivo ? `<div class="paciente-info">${esc(c.motivo)}</div>` : ""}
      </div>`).join("")}
  `;

  document.getElementById("btnBack").onclick = renderDashboard;
  document.getElementById("btnConfigHorario").onclick = renderConfigHorario;
  document.getElementById("btnNuevaCita").onclick = () => {
    const box = document.getElementById("citaFormBox");
    box.style.display = box.style.display === "none" ? "block" : "none";
  };

  document.getElementById("btnGuardarCita").onclick = async () => {
    const errBox = document.getElementById("citaErr");
    errBox.innerHTML = "";
    const pacienteId = document.getElementById("citaPacienteId").value;
    const nombreManual = document.getElementById("citaNombre").value.trim();
    const fecha = document.getElementById("citaFecha").value;
    if (!fecha || (!pacienteId && !nombreManual)) {
      errBox.innerHTML = `<div class="error">Elegí un paciente o escribí un nombre, y una fecha</div>`;
      return;
    }
    try {
      await api("/medico/citas", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          pacienteId: pacienteId || undefined,
          pacienteNombre: nombreManual,
          pacienteTelefono: document.getElementById("citaTelefono").value.trim(),
          fecha,
          motivo: document.getElementById("citaMotivo").value.trim(),
        }),
      });
      renderAgenda();
    } catch (e) {
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo guardar la cita")}</div>`;
    }
  };

  document.querySelectorAll("[data-cancelar-cita]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("¿Cancelar esta cita?")) return;
      await api("/medico/citas/" + btn.dataset.cancelarCita, {
        method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ estado: "cancelada" }),
      });
      renderAgenda();
    };
  });

  const btnReiniciarWA = document.getElementById("btnReiniciarWA");
  if (btnReiniciarWA) {
    btnReiniciarWA.onclick = async () => {
      if (!confirm("Esto desconecta el WhatsApp actual y vas a tener que escanear un QR nuevo. ¿Seguro?")) return;
      await api("/medico/whatsapp/reiniciar", { method: "POST" });
      renderAgenda();
    };
  }

  // Mientras esté configurado pero no conectado (mostrando el QR o "Conectando..."),
  // se refresca sola cada 5s hasta que el médico escanee.
  if (wa && wa.configurado && !wa.conectado) {
    pollTimeout = setTimeout(renderAgenda, 5000);
  }
}

async function renderConfigHorario() {
  detenerPolling();
  app.innerHTML = `<div class="loading">⏳ Cargando...</div>`;
  try {
    const data = await api("/medico/horario");
    pintarConfigHorario(data.horario);
  } catch (e) {
    if (e.status === 401) return logout();
    app.innerHTML = `<div class="error">${esc(e.error || "Error cargando el horario")}</div>`;
  }
}

function pintarConfigHorario(horario) {
  const dias = [1, 2, 3, 4, 5, 6, 0]; // lunes a domingo
  const porDia = {};
  (horario.horarioAtencion || []).forEach(h => { porDia[h.diaSemana] = h; });

  app.innerHTML = `
    <button class="back" id="btnBack">← Agenda</button>
    <div class="card">
      <div class="seccion-titulo" style="margin-top:0">Días y horarios de atención</div>
      <div class="hint" style="margin-bottom:10px">Tildá los días en los que atendés, con su horario. Los días sin tilde no ofrecen turnos.</div>
      ${dias.map(d => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <label style="margin:0;display:flex;align-items:center;gap:6px;min-width:70px">
            <input type="checkbox" class="diaActivo" data-dia="${d}" ${porDia[d] ? "checked" : ""} style="width:auto">
            ${DIAS_SEMANA_CORTO[d]}
          </label>
          <input type="time" class="horaInicio" data-dia="${d}" value="${porDia[d]?.horaInicio || "08:00"}" style="flex:1">
          <input type="time" class="horaFin" data-dia="${d}" value="${porDia[d]?.horaFin || "17:00"}" style="flex:1">
        </div>`).join("")}

      <label>Duración de cada consulta (minutos)</label>
      <input id="cfgDuracion" type="number" min="10" step="5" value="${horario.duracionConsultaMinutos || 30}">

      <label>Calendario de Google (opcional)</label>
      <input id="cfgCalendarId" type="text" placeholder="tu-email@gmail.com" value="${esc(horario.googleCalendarId || "")}">
      <div class="hint">Compartí ese calendario con la cuenta de servicio de Vitalis ("hacer cambios en eventos") para que las citas aparezcan ahí solas. Si lo dejás vacío, las citas quedan solo dentro de Vitalis.</div>

      <div id="cfgErr"></div>
      <button class="secondary" id="btnGuardarHorario">Guardar</button>
    </div>`;

  document.getElementById("btnBack").onclick = renderAgenda;
  document.getElementById("btnGuardarHorario").onclick = async () => {
    const errBox = document.getElementById("cfgErr");
    errBox.innerHTML = "";
    const horarioAtencion = [];
    document.querySelectorAll(".diaActivo:checked").forEach(chk => {
      const dia = chk.dataset.dia;
      const horaInicio = document.querySelector(`.horaInicio[data-dia="${dia}"]`).value;
      const horaFin = document.querySelector(`.horaFin[data-dia="${dia}"]`).value;
      if (horaInicio && horaFin) horarioAtencion.push({ diaSemana: Number(dia), horaInicio, horaFin });
    });
    try {
      await api("/medico/horario", {
        method: "PATCH", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          horarioAtencion,
          duracionConsultaMinutos: document.getElementById("cfgDuracion").value,
          googleCalendarId: document.getElementById("cfgCalendarId").value.trim(),
        }),
      });
      renderAgenda();
    } catch (e) {
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo guardar")}</div>`;
    }
  };
}
