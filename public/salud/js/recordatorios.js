// Vitalis — Recordatorios Médicos: una sola lista de "qué se viene" en todo
// el panel del médico (no por paciente), visible en el Dashboard.

const TIPOS_RECORDATORIO = {
  control: "📅 Control",
  medicamento: "💊 Medicamento",
  estudio: "🩻 Estudio",
  vacuna: "💉 Vacuna",
  otro: "🔔 Otro",
};

function tabRecordatoriosHtml(recordatorios, pacientes) {
  return `
    <div class="card">
      <div class="seccion-titulo" style="margin-top:0">🔔 Recordatorios</div>
      ${recordatorios.length === 0 ? `<div class="hint">No tenés recordatorios pendientes.</div>` : recordatorios.map(r => `
        <div class="item" style="cursor:default">
          <div class="top">
            <div class="nombre">${esc(TIPOS_RECORDATORIO[r.tipo] || r.tipo)} — ${esc(r.titulo)}</div>
            <button class="link" data-borrar-recordatorio="${r._id}" style="margin:0;width:auto;color:var(--danger)">✕</button>
          </div>
          <div class="paciente-info">${esc(r.pacienteNombre)}</div>
          <div class="fecha">${new Date(r.fecha).toLocaleDateString("es-BO")}</div>
          <button class="link" data-completar-recordatorio="${r._id}" style="margin:8px 0 0">✅ Marcar hecho</button>
        </div>`).join("")}
      <button type="button" class="link" id="btnNuevoRecordatorio" style="margin-top:${recordatorios.length ? "10px" : "0"}">➕ Nuevo recordatorio</button>
      <div id="recordFormBox" style="display:none;margin-top:12px">
        <label>Paciente</label>
        <select id="recordPaciente">
          ${pacientes.map(p => `<option value="${p._id}">${esc(p.nombre)}</option>`).join("")}
        </select>
        <label>Tipo</label>
        <select id="recordTipo">
          ${Object.entries(TIPOS_RECORDATORIO).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}
        </select>
        <label>Título</label>
        <input id="recordTitulo" type="text" placeholder="Ej: Refuerzo vacuna antitetánica">
        <label>Fecha</label>
        <input id="recordFecha" type="date">
        <div id="recordErr"></div>
        <button class="secondary" id="btnGuardarRecordatorio">Guardar recordatorio</button>
      </div>
    </div>`;
}

function wireRecordatorios(pacientes) {
  const btnNuevo = document.getElementById("btnNuevoRecordatorio");
  const formBox = document.getElementById("recordFormBox");
  if (pacientes.length === 0) {
    btnNuevo.disabled = true;
    btnNuevo.title = "Registrá un paciente primero";
  } else {
    btnNuevo.onclick = () => { formBox.style.display = formBox.style.display === "none" ? "block" : "none"; };
  }

  const btnGuardar = document.getElementById("btnGuardarRecordatorio");
  if (btnGuardar) {
    btnGuardar.onclick = async () => {
      const errBox = document.getElementById("recordErr");
      errBox.innerHTML = "";
      const pacienteId = document.getElementById("recordPaciente").value;
      const tipo = document.getElementById("recordTipo").value;
      const titulo = document.getElementById("recordTitulo").value.trim();
      const fecha = document.getElementById("recordFecha").value;
      if (!titulo || !fecha) { errBox.innerHTML = `<div class="error">Título y fecha son obligatorios</div>`; return; }
      try {
        await api("/medico/pacientes/" + pacienteId + "/recordatorios", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ tipo, titulo, fecha }),
        });
        renderDashboard();
      } catch (e) {
        errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo guardar")}</div>`;
      }
    };
  }

  document.querySelectorAll("[data-completar-recordatorio]").forEach(btn => {
    btn.onclick = async () => {
      await api("/medico/recordatorios/" + btn.dataset.completarRecordatorio, {
        method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ completado: true }),
      });
      renderDashboard();
    };
  });
  document.querySelectorAll("[data-borrar-recordatorio]").forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("¿Eliminar este recordatorio?")) return;
      await api("/medico/recordatorios/" + btn.dataset.borrarRecordatorio, { method: "DELETE" });
      renderDashboard();
    };
  });
}
