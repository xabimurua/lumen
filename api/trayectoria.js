// POST /api/trayectoria — at the participant's own request, searches the web for their public track record
// and stores candidate experiences for them to confirm one by one.
import { randomUUID } from "node:crypto";
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { traceRecord } from "../lib/claude.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    if (body.acepto !== true) throw new HttpError(400, "Para buscar tu trayectoria tienes que autorizar la búsqueda.");
    const nombre = String(body.nombre || "").trim().slice(0, 120);
    if (nombre.split(/\s+/).length < 2) throw new HttpError(400, "Escribe tu nombre y al menos un apellido, para no confundirte con otras personas.");
    const pistas = String(body.pistas || "").trim().slice(0, 600);
    const enlaces = (Array.isArray(body.enlaces) ? body.enlaces : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\/\S+\.\S+/.test(u)).slice(0, 5);

    await chargeAiCall(user.id);
    const { items } = await traceRecord({ nombre, pistas, enlaces });

    // Keep what the person already decided on; replace only the pending candidates.
    const anterior = perfil.trayectoria?.items || [];
    const decididos = anterior.filter((x) => x.estado !== "pendiente");
    const vistos = new Set(decididos.map((x) => `${x.titulo}|${x.organizacion}`.toLowerCase()));
    const nuevos = items.filter((x) => !vistos.has(`${x.titulo}|${x.organizacion}`.toLowerCase())).map((x) => ({ ...x, id: randomUUID(), estado: "pendiente" }));
    const trayectoria = { buscada: new Date().toISOString(), nombre, pistas, enlaces, items: [...nuevos, ...decididos] };
    const { error } = await adminClient().from("perfiles").update({ trayectoria }).eq("user_id", user.id);
    if (error) throw new HttpError(500, "No se pudo guardar tu trayectoria. ¿Está aplicada la migración 004 en Supabase?");
    res.status(200).json({ trayectoria, encontrados: nuevos.length });
  } catch (err) {
    sendError(res, err);
  }
}
