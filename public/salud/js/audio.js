// Vitalis — grabación de audio: onda de voz en vivo, subida de consultas, y
// vista previa de transcripción en vivo (WebSocket a AssemblyAI). Lo usan
// tanto la grabación local (consultas.js) como el celular vinculado
// (vinculacion.js).

// Dibuja la onda de voz en vivo sobre un <canvas>, a partir de un MediaStream
// del micrófono. Se usa tanto grabando local (compu con micrófono) como en
// el celular vinculado como micrófono remoto.
function crearVisualizadorOnda(waveCanvas) {
  let audioCtx = null, analyser = null, dataArray = null, animId = null;

  function dibujar() {
    animId = requestAnimationFrame(dibujar);
    analyser.getByteFrequencyData(dataArray);
    const ctx = waveCanvas.getContext("2d");
    const w = waveCanvas.width, h = waveCanvas.height;
    ctx.clearRect(0, 0, w, h);
    const bars = 32;
    const step = Math.floor(dataArray.length / bars);
    const barWidth = w / bars;
    for (let i = 0; i < bars; i++) {
      const value = dataArray[i * step] / 255;
      const barHeight = Math.max(4, value * h * 0.9);
      const x = i * barWidth;
      const y = (h - barHeight) / 2;
      const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
      grad.addColorStop(0, "#22d3ee");
      grad.addColorStop(1, "#0891b2");
      ctx.fillStyle = grad;
      const bw = barWidth * 0.6, r = bw / 2;
      const bx = x + barWidth * 0.2;
      ctx.beginPath();
      ctx.moveTo(bx + r, y);
      ctx.arcTo(bx + bw, y, bx + bw, y + barHeight, r);
      ctx.arcTo(bx + bw, y + barHeight, bx, y + barHeight, r);
      ctx.arcTo(bx, y + barHeight, bx, y, r);
      ctx.arcTo(bx, y, bx + bw, y, r);
      ctx.closePath();
      ctx.fill();
    }
  }

  return {
    iniciar(stream) {
      const dpr = window.devicePixelRatio || 1;
      const rect = waveCanvas.getBoundingClientRect();
      waveCanvas.width = rect.width * dpr;
      waveCanvas.height = rect.height * dpr;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      dibujar();
    },
    detener() {
      if (animId) cancelAnimationFrame(animId);
      if (audioCtx) audioCtx.close();
      audioCtx = null; analyser = null;
    },
  };
}

// Sube el audio grabado/subido y crea la consulta. Se usa tanto grabando
// local como desde el celular vinculado como micrófono remoto.
async function subirConsulta(pacienteId, blob, mimeType) {
  return api("/medico/consultas?pacienteId=" + encodeURIComponent(pacienteId), {
    method: "POST",
    headers: { "Content-Type": mimeType || "audio/webm" },
    body: blob,
  });
}

// Vista previa en vivo: mientras se graba (para el archivo real, que es lo
// que se guarda), en paralelo se manda el audio en crudo (PCM 16kHz) al
// WebSocket de AssemblyAI para mostrar el texto apareciendo mientras se
// habla. Si esto falla por lo que sea, no afecta la grabación real — es
// solo decorativo, la transcripción de verdad sigue viniendo del archivo
// subido al terminar.
function crearTranscriptorEnVivo(onTexto) {
  let ws = null, audioCtx = null, workletNode = null, source = null;

  const CODIGO_WORKLET = `
    class PCMWorklet extends AudioWorkletProcessor {
      constructor() {
        super();
        this.ratio = sampleRate / 16000;
      }
      process(inputs) {
        const input = inputs[0][0];
        if (input && input.length) {
          const outLen = Math.max(1, Math.floor(input.length / this.ratio));
          const buf = new Int16Array(outLen);
          for (let i = 0; i < outLen; i++) {
            const srcIdx = i * this.ratio;
            const i0 = Math.floor(srcIdx);
            const i1 = Math.min(i0 + 1, input.length - 1);
            const frac = srcIdx - i0;
            const sample = input[i0] * (1 - frac) + input[i1] * frac;
            const s = Math.max(-1, Math.min(1, sample));
            buf[i] = s < 0 ? s * 32768 : s * 32767;
          }
          this.port.postMessage(buf.buffer, [buf.buffer]);
        }
        return true;
      }
    }
    registerProcessor("pcm-worklet", PCMWorklet);
  `;

  async function iniciar(stream) {
    try {
      const { token } = await api("/medico/transcripcion-token");
      const url = "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le"
        + "&format_turns=true&speech_model=universal-streaming-multilingual&token=" + encodeURIComponent(token);
      ws = new WebSocket(url);

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const blobUrl = URL.createObjectURL(new Blob([CODIGO_WORKLET], { type: "application/javascript" }));
      await audioCtx.audioWorklet.addModule(blobUrl);
      source = audioCtx.createMediaStreamSource(stream);
      workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet");
      source.connect(workletNode);

      let textoAcumulado = "";
      workletNode.port.onmessage = (e) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg.transcript) return;
          if (msg.end_of_turn) {
            textoAcumulado += msg.transcript + " ";
            onTexto(textoAcumulado);
          } else {
            onTexto(textoAcumulado + msg.transcript);
          }
        } catch {}
      };
      ws.onerror = () => {}; // decorativo — si falla, seguimos grabando igual
    } catch (e) {
      console.warn("Transcripción en vivo no disponible:", e.message);
    }
  }

  function detener() {
    if (workletNode) { try { workletNode.disconnect(); } catch {} }
    if (source) { try { source.disconnect(); } catch {} }
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    if (ws) { try { ws.close(); } catch {} }
    ws = null; audioCtx = null; workletNode = null; source = null;
  }

  return { iniciar, detener };
}
