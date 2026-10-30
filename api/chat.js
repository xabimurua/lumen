// POST /api/chat — next interviewer turn, streamed as plain text.
import { allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { parseHistory, streamInterviewTurn } from "../lib/claude.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const history = parseHistory(body.history);
    const titulo = String(body.titulo || "").slice(0, 300);
    if (!titulo) throw new HttpError(400, "Falta indicar qué quieres documentar.");
    await chargeAiCall(user.id);

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    await streamInterviewTurn({
      objetivo: perfil.objetivo,
      titulo,
      history,
      closing: body.closing === true,
      onText: (t) => res.write(t),
    });
    res.end();
  } catch (err) {
    sendError(res, err);
  }
}
