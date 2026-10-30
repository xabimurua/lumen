// POST /api/analyze — structured analyses: closing an interview, linking a diary entry, extracting outcomes.
import { allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { analyzeInterview, extractOutcomes, linkDiary, parseHistory, CONTEXTOS } from "../lib/claude.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const today = new Date().toISOString().slice(0, 10);

    if (body.kind === "interview") {
      const history = parseHistory(body.history);
      await chargeAiCall(user.id);
      const out = await analyzeInterview({ objetivo: perfil.objetivo, titulo: String(body.titulo || "").slice(0, 300), history, today });
      return res.status(200).json(out);
    }
    if (body.kind === "diary") {
      const texto = String(body.texto || "").trim().slice(0, 4000);
      if (!texto) throw new HttpError(400, "La entrada del diario está vacía.");
      const contexto = CONTEXTOS.includes(body.contexto) ? body.contexto : "";
      await chargeAiCall(user.id);
      const out = await linkDiary({ objetivo: perfil.objetivo, texto, contexto, horas: Number(body.horas) || 0 });
      return res.status(200).json(out);
    }
    if (body.kind === "extract") {
      const guia = String(body.guia || "").trim().slice(0, 30000);
      if (!guia) throw new HttpError(400, "Pega primero el texto de la guía docente.");
      await chargeAiCall(user.id);
      return res.status(200).json({ resultados: await extractOutcomes(guia) });
    }
    throw new HttpError(400, "Tipo de análisis desconocido.");
  } catch (err) {
    sendError(res, err);
  }
}
