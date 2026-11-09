// POST /api/trayectoria — loads the participant's experience at their request: reads their CV, searches the
// web for their public track record and looks for public backing. Streams progress as NDJSON lines:
// {tipo:"paso",texto} … then {tipo:"fin",trayectoria,encontrados} or {tipo:"error",mensaje}.
import { randomUUID } from "node:crypto";
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { importExperience } from "../lib/investigacion.js";
import { documentFromStorage } from "../lib/documentos.js";

const clave = (x) => `${x.titulo}|${x.organizacion}`.toLowerCase();

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  let streaming = false;
  const send = (o) => res.write(JSON.stringify(o) + "\n");
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const web = body.acepto === true;
    const cv = body.cv?.path ? { path: String(body.cv.path), name: String(body.cv.name || "Currículum").slice(0, 200) } : null;
    if (!web && !cv) throw new HttpError(400, "Sube tu currículum o autoriza la búsqueda en internet.");
    if (cv && (!cv.path.startsWith(`${user.id}/fuentes/cv/`) || cv.path.includes(".."))) throw new HttpError(400, "El currículum no es válido.");
    const nombre = String(body.nombre || "").trim().slice(0, 120);
    if (web && nombre.split(/\s+/).length < 2) throw new HttpError(400, "Escribe tu nombre y al menos un apellido, para no confundirte con otras personas.");
    const pistas = String(body.pistas || "").trim().slice(0, 600);
    const enlaces = (Array.isArray(body.enlaces) ? body.enlaces : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\/\S+\.\S+/.test(u)).slice(0, 5);
    const cvDoc = cv ? await documentFromStorage(user.id, cv.path, cv.name) : null;
    if (cvDoc && cvDoc.type !== "document") throw new HttpError(415, "Sube el currículum en PDF o en texto.");
    for (let i = 0; i < (cv ? 1 : 0) + (web ? 2 : 0); i++) await chargeAiCall(user.id);

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    streaming = true;
    const items = await importExperience({ nombre: nombre || "la persona", pistas, enlaces, cvDoc, web, onStep: (texto) => send({ tipo: "paso", texto }) });

    // Keep everything from earlier imports: what the person decided on, and what is still waiting for review.
    const anterior = perfil.trayectoria?.items || [];
    const vistos = new Set(anterior.map(clave));
    const nuevos = items.filter((x) => !vistos.has(clave(x))).map((x) => ({ ...x, id: randomUUID(), estado: "pendiente" }));
    const trayectoria = { buscada: new Date().toISOString(), nombre: nombre || perfil.trayectoria?.nombre || "", pistas, enlaces, cv: cv || perfil.trayectoria?.cv || null, items: [...nuevos, ...anterior] };
    const { error } = await adminClient().from("perfiles").update({ trayectoria }).eq("user_id", user.id);
    if (error) throw new HttpError(500, "No se pudo guardar tu trayectoria. ¿Está aplicada la migración 004 en Supabase?");
    send({ tipo: "fin", trayectoria, encontrados: nuevos.length });
    res.end();
  } catch (err) {
    if (!streaming) return sendError(res, err);
    // Headers are already sent: report the failure as the last line of the stream.
    const holder = { headersSent: false, status() { return this; }, json(o) { send({ tipo: "error", mensaje: o.error }); } };
    sendError(holder, err);
    res.end();
  }
}
