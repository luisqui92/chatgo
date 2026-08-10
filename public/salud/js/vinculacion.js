// Vitalis — Vincular este celular como micrófono remoto (ver también
// consultas.js: pintarControlRemoto, que vive del lado de la compu).

async function renderVincular() {
  detenerPolling();
  app.innerHTML = `<div class="loading">⏳ Cargando...</div>`;
  try {
    const data = await api("/medico/vinculacion");
    pintarVincular(data.vinculacion);
  } catch (e) {
    if (e.status === 401) return logout();
    app.innerHTML = `<div class="error">${esc(e.error || "Error cargando la vinculación")}</div>`;
  }
}

function pintarVincular(v) {
  if (!v.vinculado) {
    app.innerHTML = `
      <button class="back" id="btnBack">← Volver</button>
      <div class="card">
        <div class="hint" style="margin-bottom:14px">Escribí el código de 6 dígitos que aparece en la compu:</div>
        <input id="vCodigo" type="tel" maxlength="6" placeholder="000000" style="text-align:center;font-size:24px;letter-spacing:6px">
        <div id="vErr"></div>
        <button class="primary" id="vBtn">Vincular</button>
      </div>`;
    document.getElementById("btnBack").onclick = renderDashboard;
    document.getElementById("vBtn").onclick = async () => {
      const codigo = document.getElementById("vCodigo").value.trim();
      const errBox = document.getElementById("vErr");
      errBox.innerHTML = "";
      try {
        const data = await api("/medico/vinculacion/vincular", {
          method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ codigo }),
        });
        pintarVincular(data.vinculacion);
      } catch (e) {
        errBox.innerHTML = `<div class="error">${esc(e.error || "No se pudo vincular")}</div>`;
      }
    };
    return;
  }

  // Ya vinculado: queda "armado" mirando si la compu mandó una orden.
  app.innerHTML = `
    <button class="back" id="btnBack">← Volver</button>
    <div class="card" id="vCard">
      <div class="hint">📱 Celular vinculado. Dejalo con la pantalla prendida al lado de la compu.</div>
      <div class="hint" style="margin-top:10px" id="vEstado">🟢 Esperando la orden de grabar...</div>
    </div>`;
  document.getElementById("btnBack").onclick = renderDashboard;

  let mediaRecorder = null, chunks = [], mimeType = "audio/webm", stream = null;
  let pacienteActual = null;

  async function arrancarGrabacionRemota(pacienteId, pacienteNombre) {
    pacienteActual = { pacienteId, pacienteNombre };
    document.getElementById("vCard").innerHTML = `
      <div class="listen-panel" style="display:block">
        <canvas id="waveCanvasRemoto"></canvas>
        <div class="listen-time" id="recTimeRemoto">00:00</div>
        <div class="listen-label">🎙️ Grabando: ${esc(pacienteNombre)}</div>
      </div>
      <div class="hint" style="text-align:center">Esperando que la compu diga "detener"...</div>
      <button class="secondary" id="btnDetenerLocal">⏹️ Detener acá mismo</button>`;
    const visual = crearVisualizadorOnda(document.getElementById("waveCanvasRemoto"));
    const recTime = document.getElementById("recTimeRemoto");

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tipos = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    mimeType = tipos.find(t => MediaRecorder.isTypeSupported(t)) || "";
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    let seconds = 0;
    const timerId = setInterval(() => { seconds++; recTime.textContent = fmt(seconds); }, 1000);
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = async () => {
      clearInterval(timerId);
      visual.detener();
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      document.getElementById("vCard").innerHTML = `<div class="hint">⏳ Subiendo la grabación...</div>`;
      try {
        const data = await subirConsulta(pacienteActual.pacienteId, blob, mimeType);
        await api("/medico/vinculacion/estado", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ estado: "armado", consultaId: data.consulta._id }),
        });
      } catch (e) {
        await api("/medico/vinculacion/estado", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ estado: "armado" }),
        }).catch(() => {});
      }
      pintarVincular({ vinculado: true, estado: "armado" });
    };
    mediaRecorder.start();
    visual.iniciar(stream);
    document.getElementById("btnDetenerLocal").onclick = () => mediaRecorder.stop();

    await api("/medico/vinculacion/estado", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ estado: "grabando" }),
    }).catch(() => {});
  }

  (async function ciclo() {
    try {
      const data = await api("/medico/vinculacion");
      const vv = data.vinculacion;
      if (!vv.vinculado) return renderVincular(); // se desvinculó (cambió el día)

      if (vv.comandoPendiente?.accion === "iniciar" && (!mediaRecorder || mediaRecorder.state === "inactive")) {
        await arrancarGrabacionRemota(vv.comandoPendiente.pacienteId, vv.comandoPendiente.pacienteNombre);
      } else if (vv.comandoPendiente?.accion === "detener" && mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    } catch (e) {
      if (e.status === 401) return logout();
    }
    pollTimeout = setTimeout(ciclo, 1500);
  })();
}
