// POST /api/chat — next interviewer turn, streamed as plain text.
import { allowMethods, chargeAiCall, objetivoDe, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { parseHistory, streamInterviewTurn } from "../lib/claude.js";
import { loadSource } from "../lib/fuente.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    await requireConsentedProfile(user.id);
    const body = readJson(req);
    const history = parseHistory(body.history);
    const titulo = String(body.titulo || "").slice(0, 300);
    if (!titulo) throw new HttpError(400, "Falta indicar qué quieres documentar.");
    const [fuente, contexto] = await Promise.all([loadSource(user.id, body.fuente), loadSource(user.id, body.contexto)]);
    await chargeAiCall(user.id);

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    await streamInterviewTurn({
      objetivo: await objetivoDe(user.id, body.acreditacion_id),
      titulo,
      history,
      closing: body.closing === true,
      fuente,
      contexto,
      onText: (t) => res.write(t),
    });
    res.end();
  } catch (err) {
    sendError(res, err);
  }
}
