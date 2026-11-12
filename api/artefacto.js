// POST /api/artefacto — Lumen reads a proof the participant attached (uploaded file or external link)
// and reviews it against their official learning outcomes.
import { objetivoDe, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { reviewArtefact } from "../lib/claude.js";
import { documentFromStorage, documentFromUrl } from "../lib/documentos.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const nombre = String(body.nombre || "documento").slice(0, 200);
    const url = String(body.url || "").trim();
    let doc;
    if (body.path) doc = await documentFromStorage(user.id, body.path, nombre);
    else if (/^https?:\/\//i.test(url)) doc = await documentFromUrl(url, nombre, { minChars: 80 });
    else throw new HttpError(400, "Falta el archivo o el enlace.");

    // Learning outcomes always come from the official catalog, never from what the browser sends.
    const objetivo = body.acreditacion_id ? await objetivoDe(user.id, body.acreditacion_id) : null;
    const evidencia = { titulo: String(body.evidencia?.titulo || "").slice(0, 200), resumen: String(body.evidencia?.resumen || "").slice(0, 1500) };
    await chargeAiCall(user.id);
    const r = await reviewArtefact({ doc, nombre, evidencia, objetivo, titular: perfil.nombre || "" });
    res.status(200).json({ ...r, revisado: new Date().toISOString() });
  } catch (err) {
    if (err?.name === "TimeoutError") err = new HttpError(504, "La página tardó demasiado en responder.");
    sendError(res, err);
  }
}
