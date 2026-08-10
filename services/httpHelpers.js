// ChatGo Salud — helpers compartidos para las rutas /medico/*, para no repetir
// el mismo try/catch + "buscar y verificar dueño" en cada endpoint nuevo.
const { log } = require("../config");

class ErrorHttp extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

// Envuelve un handler async: si tira ErrorHttp, responde con ese status/mensaje;
// si tira cualquier otra cosa, la loguea y responde 500 genérico.
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e instanceof ErrorHttp) {
        return res.status(e.status).json({ error: e.publicMessage });
      }
      log.error(`[${req.method} ${req.path}]`, e.message);
      res.status(500).json({ error: "Error interno" });
    }
  };
}

// Busca un documento propio del médico (o lanza 404). El filtro SIEMPRE debe
// incluir medicoPhone — así ningún endpoint nuevo se olvida de aislar por dueño.
async function obtenerOFallar(Modelo, filtro, mensajeNoEncontrado = "No encontrado") {
  if (!filtro.medicoPhone) throw new Error("obtenerOFallar: el filtro debe incluir medicoPhone");
  const doc = await Modelo.findOne(filtro);
  if (!doc) throw new ErrorHttp(404, mensajeNoEncontrado);
  return doc;
}

module.exports = { asyncRoute, ErrorHttp, obtenerOFallar };
