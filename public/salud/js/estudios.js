// Vitalis — Centro de Estudios: laboratorios, radiografías, ecografías,
// tomografías, resonancias, ECG y fotos clínicas, todos ligados al paciente.

const TIPOS_ESTUDIO = {
  laboratorio: "🧪 Laboratorio",
  radiografia: "🦴 Radiografía",
  ecografia: "🔊 Ecografía",
  tomografia: "🌀 Tomografía",
  resonancia: "🧲 Resonancia",
  ecg: "💓 ECG",
  foto: "📷 Foto clínica",
  otro: "📄 Otro",
};

function tabEstudiosHtml(estudios) {
  return `
    <div class="card">
      <div class="seccion-titulo" style="margin-top:0">Subir estudio</div>
      <select id="estTipo">
        ${Object.entries(TIPOS_ESTUDIO).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}
      </select>
      <input id="estNombre" type="text" placeholder="Título (ej: Hemograma completo)" style="margin-top:8px">
      <label>Fecha</label>
      <input id="estFecha" type="date" value="${new Date().toISOString().slice(0, 10)}">
      <label class="file-label" for="estArchivo">📎 Elegir imagen o PDF</label>
      <input type="file" id="estArchivo" accept="image/*,application/pdf" style="display:none">
      <div id="estArchivoNombre" class="hint"></div>
      <div id="estErr"></div>
      <button class="secondary" id="btnSubirEstudio">⬆️ Subir</button>
    </div>
    ${estudios.length === 0 ? `<div class="empty">Todavía no hay estudios cargados.</div>` : ""}
    ${estudios.map(e => `
      <div class="item" data-ver-estudio="${e._id}">
        <div class="top">
          <div class="nombre">${esc(TIPOS_ESTUDIO[e.tipo] || e.tipo)} — ${esc(e.nombre)}</div>
          <button class="link" data-borrar-estudio="${e._id}" style="margin:0;width:auto;color:var(--danger)">✕</button>
        </div>
        <div class="fecha">${new Date(e.fecha).toLocaleDateString("es-BO")}</div>
        ${e.notas ? `<div class="paciente-info">📝 ${esc(e.notas)}</div>` : ""}
      </div>`).join("")}
  `;
}

function wireTabEstudios(p, estudios) {
  let archivoSeleccionado = null;
  const inputArchivo = document.getElementById("estArchivo");
  const nombreArchivoEl = document.getElementById("estArchivoNombre");
  inputArchivo.onchange = (e) => {
    archivoSeleccionado = e.target.files[0] || null;
    nombreArchivoEl.textContent = archivoSeleccionado ? "Archivo: " + archivoSeleccionado.name : "";
  };

  const btnSubir = document.getElementById("btnSubirEstudio");
  btnSubir.onclick = async () => {
    const errBox = document.getElementById("estErr");
    errBox.innerHTML = "";
    const nombre = document.getElementById("estNombre").value.trim();
    const fecha = document.getElementById("estFecha").value;
    const tipo = document.getElementById("estTipo").value;
    if (!nombre || !fecha) { errBox.innerHTML = `<div class="error">Título y fecha son obligatorios</div>`; return; }
    if (!archivoSeleccionado) { errBox.innerHTML = `<div class="error">Elegí una imagen o PDF</div>`; return; }

    btnSubir.disabled = true;
    btnSubir.textContent = "Subiendo...";
    try {
      const qs = "?tipo=" + encodeURIComponent(tipo) + "&nombre=" + encodeURIComponent(nombre) + "&fecha=" + encodeURIComponent(fecha);
      await api("/medico/pacientes/" + p._id + "/estudios" + qs, {
        method: "POST",
        headers: { "Content-Type": archivoSeleccionado.type || "application/octet-stream" },
        body: archivoSeleccionado,
      });
      renderPacienteDetalle(p._id, "estudios");
    } catch (e) {
      btnSubir.disabled = false;
      btnSubir.textContent = "⬆️ Subir";
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo subir el archivo")}</div>`;
    }
  };

  document.querySelectorAll("[data-ver-estudio]").forEach(el => {
    el.onclick = () => abrirArchivoEstudio(el.dataset.verEstudio);
  });
  document.querySelectorAll("[data-borrar-estudio]").forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("¿Eliminar este estudio?")) return;
      await api("/medico/estudios/" + btn.dataset.borrarEstudio, { method: "DELETE" });
      renderPacienteDetalle(p._id, "estudios");
    };
  });
}

// El archivo puede ser grande y va con Authorization por header (no por URL),
// así que se trae como blob y se abre en una pestaña nueva en vez de un <a href>.
async function abrirArchivoEstudio(id) {
  try {
    const headers = {};
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const res = await fetch(API + "/medico/estudios/" + id + "/archivo", { headers });
    if (!res.ok) { alert("No se pudo abrir el archivo"); return; }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  } catch (e) {
    alert("No se pudo abrir el archivo");
  }
}
