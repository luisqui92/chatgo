// Vitalis — Memoria Clínica Conversacional: preguntale al Kardex en lenguaje
// natural sobre la historia de un paciente puntual. El chat es solo de esta
// sesión (no se persiste), por paciente.
const memoriaHistorialPorPaciente = {};

function tabMemoriaHtml(pacienteId) {
  const historial = memoriaHistorialPorPaciente[pacienteId] || [];
  return `
    <div class="card">
      <div class="nota-titulo">💬 Preguntale al Kardex</div>
      <div class="hint" style="margin-bottom:10px">Preguntá en lenguaje natural sobre la historia de este paciente. Ej: "¿cuándo fue su último control de presión?"</div>
      <div id="memoriaChat">${pintarMemoriaChat(historial)}</div>
      <input id="memoriaInput" type="text" placeholder="Escribí tu pregunta...">
      <div id="memoriaErr"></div>
      <button class="secondary" id="btnPreguntar">Preguntar</button>
    </div>`;
}

function pintarMemoriaChat(historial) {
  return historial.map(h => `
    <div class="memoria-pregunta">🧑‍⚕️ ${esc(h.pregunta)}</div>
    <div class="memoria-respuesta">🤖 ${esc(h.respuesta)}</div>
  `).join("");
}

function wireTabMemoria(p) {
  const btn = document.getElementById("btnPreguntar");
  const input = document.getElementById("memoriaInput");
  const errBox = document.getElementById("memoriaErr");
  const chatBox = document.getElementById("memoriaChat");

  const repintar = () => {
    chatBox.innerHTML = pintarMemoriaChat(memoriaHistorialPorPaciente[p._id] || []);
    chatBox.scrollTop = chatBox.scrollHeight;
  };

  const preguntar = async () => {
    const pregunta = input.value.trim();
    if (!pregunta) return;
    errBox.innerHTML = "";
    input.value = "";
    btn.disabled = true;
    btn.textContent = "Pensando...";

    if (!memoriaHistorialPorPaciente[p._id]) memoriaHistorialPorPaciente[p._id] = [];
    const historial = memoriaHistorialPorPaciente[p._id];
    historial.push({ pregunta, respuesta: "…" });
    repintar();

    try {
      const data = await api("/medico/pacientes/" + p._id + "/preguntar", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ pregunta }),
      });
      historial[historial.length - 1].respuesta = data.respuesta;
    } catch (e) {
      historial.pop();
      errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo responder la pregunta")}</div>`;
    }
    btn.disabled = false;
    btn.textContent = "Preguntar";
    repintar();
  };

  btn.onclick = preguntar;
  input.onkeydown = (e) => { if (e.key === "Enter") preguntar(); };
}
