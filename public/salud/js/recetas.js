// Vitalis — Receta Digital: se arma desde una consulta o a mano, y se
// imprime/descarga como PDF con el diálogo nativo del navegador (sin sumar
// una librería de PDF en el servidor solo para esto).

function filaMedicamentoHtml() {
  return `
    <div class="rec-row">
      <input class="recNombre" type="text" placeholder="Medicamento (ej: Amoxicilina)">
      <input class="recDosis" type="text" placeholder="Dosis (ej: 500mg)" style="margin-top:8px">
      <input class="recFrecuencia" type="text" placeholder="Frecuencia (ej: cada 8 horas)" style="margin-top:8px">
      <input class="recDuracion" type="text" placeholder="Duración (ej: 7 días)" style="margin-top:8px">
      <button type="button" class="quitar-fila">✕ Quitar</button>
    </div>`;
}

function tabRecetasHtml(recetas) {
  return `
    <div class="card">
      <div class="seccion-titulo" style="margin-top:0">Nueva receta</div>
      <label>Fecha</label>
      <input id="recFecha" type="date" value="${new Date().toISOString().slice(0, 10)}">
      <div id="recRows">${filaMedicamentoHtml()}</div>
      <button type="button" class="link" id="btnAgregarFila">➕ Agregar otro medicamento</button>
      <label>Indicaciones generales (opcional)</label>
      <textarea id="recIndicaciones" rows="3" placeholder="Reposo, dieta, control en 7 días..."></textarea>
      <div id="recErr"></div>
      <button class="secondary" id="btnGuardarReceta">💾 Guardar y ver receta</button>
    </div>
    ${recetas.length === 0 ? `<div class="empty">Todavía no hay recetas emitidas.</div>` : ""}
    ${recetas.map(r => `
      <div class="item" data-ver-receta="${r._id}">
        <div class="top">
          <div class="nombre">${esc(r.medicamentos.map(m => m.nombre).join(", "))}</div>
          <button class="link" data-borrar-receta="${r._id}" style="margin:0;width:auto;color:var(--danger)">✕</button>
        </div>
        <div class="fecha">${new Date(r.fecha).toLocaleDateString("es-BO")}</div>
      </div>`).join("")}
  `;
}

function wireTabRecetas(p, recetas) {
  document.getElementById("btnAgregarFila").onclick = () => {
    document.getElementById("recRows").insertAdjacentHTML("beforeend", filaMedicamentoHtml());
  };

  document.getElementById("recRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("quitar-fila")) {
      const filas = document.querySelectorAll(".rec-row");
      if (filas.length > 1) e.target.closest(".rec-row").remove();
    }
  });

  document.getElementById("btnGuardarReceta").onclick = async () => {
    const errBox = document.getElementById("recErr");
    errBox.innerHTML = "";
    const medicamentos = [...document.querySelectorAll(".rec-row")].map(fila => ({
      nombre: fila.querySelector(".recNombre").value.trim(),
      dosis: fila.querySelector(".recDosis").value.trim(),
      frecuencia: fila.querySelector(".recFrecuencia").value.trim(),
      duracion: fila.querySelector(".recDuracion").value.trim(),
    })).filter(m => m.nombre);

    if (medicamentos.length === 0) { errBox.innerHTML = `<div class="error">Agregá al menos un medicamento</div>`; return; }

    const btn = document.getElementById("btnGuardarReceta");
    btn.disabled = true;
    btn.textContent = "Guardando...";
    try {
      const data = await api("/medico/pacientes/" + p._id + "/recetas", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          medicamentos,
          indicaciones: document.getElementById("recIndicaciones").value.trim(),
          fecha: document.getElementById("recFecha").value,
        }),
      });
      renderReceta(data.receta._id);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar y ver receta";
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo guardar la receta")}</div>`;
    }
  };

  document.querySelectorAll("[data-ver-receta]").forEach(el => {
    el.onclick = () => renderReceta(el.dataset.verReceta);
  });
  document.querySelectorAll("[data-borrar-receta]").forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("¿Eliminar esta receta?")) return;
      await api("/medico/recetas/" + btn.dataset.borrarReceta, { method: "DELETE" });
      renderPacienteDetalle(p._id, "recetas");
    };
  });
}

// ─── VER/IMPRIMIR UNA RECETA ─────────────────────────────────────────────
async function renderReceta(id) {
  detenerPolling();
  app.innerHTML = `<div class="loading">⏳ Cargando...</div>`;
  try {
    const data = await api("/medico/recetas/" + id);
    const { receta, paciente, medico } = data;
    const edad = edadDesde(paciente.fechaNacimiento);

    app.innerHTML = `
      <button class="back no-imprimir" id="btnBack">← Volver</button>
      <div class="card" id="recetaHoja" style="padding:28px">
        <div style="text-align:center;margin-bottom:18px">
          <img src="/salud/logo.png" style="width:44px;height:44px;object-fit:contain">
          <div style="font-size:16px;font-weight:700;color:var(--primary);margin-top:4px">Vitalis</div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:12px">
          <div>
            <div><b>${esc(medico.nombre)}</b></div>
            ${medico.especialidad ? `<div>${esc(medico.especialidad)}</div>` : ""}
          </div>
          <div>${new Date(receta.fecha).toLocaleDateString("es-BO")}</div>
        </div>
        <div style="font-size:13px;margin-bottom:20px">
          <b>Paciente:</b> ${esc(paciente.nombre)}${edad != null ? " · " + edad + " años" : ""}${paciente.sexo ? " · " + esc(paciente.sexo) : ""}
        </div>
        <div class="seccion-titulo" style="margin-top:0">Rp/</div>
        ${receta.medicamentos.map((m, i) => `
          <div style="margin-bottom:14px">
            <div style="font-weight:600">${i + 1}. ${esc(m.nombre)}${m.dosis ? " — " + esc(m.dosis) : ""}</div>
            ${(m.frecuencia || m.duracion) ? `<div style="font-size:13px;color:var(--text-muted)">${[m.frecuencia, m.duracion].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
          </div>`).join("")}
        ${receta.indicaciones ? `
          <div class="seccion-titulo">Indicaciones</div>
          <div style="font-size:13px;white-space:pre-wrap">${esc(receta.indicaciones)}</div>` : ""}
      </div>
      <button class="secondary no-imprimir" id="btnImprimirReceta">🖨️ Imprimir / Descargar PDF</button>
    `;
    document.getElementById("btnBack").onclick = () => renderPacienteDetalle(receta.pacienteId, "recetas");
    document.getElementById("btnImprimirReceta").onclick = () => window.print();
  } catch (e) {
    if (e.status === 401) return logout();
    app.innerHTML = `<div class="error">${esc(e.error || "Error cargando la receta")}</div>`;
  }
}
