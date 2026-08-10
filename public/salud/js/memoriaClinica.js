// Vitalis — Memoria Clínica Conversacional: preguntale al Kardex en lenguaje
// natural sobre la historia de un paciente puntual. El chat es solo de esta
// sesión (no se persiste), por paciente.
const memoriaHistorialPorPaciente = {};

function tabMemoriaHtml(pacienteId) {
  const historial = memoriaHistorialPorPaciente[pacienteId] || [];
  return `
    <div class="card">
      <div class="nota-titulo">💬 Preguntale al Kardex</div>
      <div id="memoriaChat">${pintarMemoriaChat(historial)}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:14px">
        <input id="memoriaInput" type="text" placeholder="Ej: ¿cuándo fue su último control de presión?" style="flex:1;width:auto;margin-top:0">
        <button type="button" id="btnMicMemoria" class="mic-btn" title="Preguntar por voz">🎙️</button>
      </div>
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

// Preguntar por voz con el reconocimiento de voz del navegador (Web Speech
// API) — mucho más simple que el pipeline de AssemblyAI usado para grabar
// consultas completas, y suficiente para una pregunta corta y puntual.
function crearReconocedorVozMemoria() {
  const Reconocedor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Reconocedor) return null;
  const r = new Reconocedor();
  r.lang = "es-419";
  r.interimResults = false;
  r.maxAlternatives = 1;
  return r;
}

function wireTabMemoria(p) {
  const btn = document.getElementById("btnPreguntar");
  const input = document.getElementById("memoriaInput");
  const errBox = document.getElementById("memoriaErr");
  const chatBox = document.getElementById("memoriaChat");
  const btnMic = document.getElementById("btnMicMemoria");

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

  const reconocedor = crearReconocedorVozMemoria();
  if (!reconocedor) {
    btnMic.disabled = true;
    btnMic.title = "Tu navegador no soporta preguntas por voz";
  } else {
    let escuchando = false;
    reconocedor.onstart = () => { escuchando = true; btnMic.classList.add("escuchando"); };
    reconocedor.onend = () => { escuchando = false; btnMic.classList.remove("escuchando"); };
    reconocedor.onerror = () => {
      errBox.innerHTML = `<div class="error">No se pudo escuchar la pregunta. Probá de nuevo.</div>`;
    };
    reconocedor.onresult = (e) => {
      input.value = e.results[0][0].transcript;
      preguntar();
    };
    btnMic.onclick = () => {
      if (escuchando) { reconocedor.stop(); return; }
      errBox.innerHTML = "";
      try { reconocedor.start(); } catch (e) { /* ya estaba escuchando */ }
    };
  }
}
