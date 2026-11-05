// POST /api/recursos — recommends real books, videos, articles, podcasts and courses for the learning
// outcomes of the participant's accreditation that still lack evidence.
import { randomUUID } from "node:crypto";
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { recommendResources } from "../lib/claude.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const admin = adminClient();
    const id = perfil.objetivo?.asignatura_id;
    if (!id) throw new HttpError(400, "Elige primero una acreditación: las recomendaciones se basan en sus resultados de aprendizaje.");
    const [{ data: asig }, { data: rows }] = await Promise.all([
      admin.from("catalogo_asignaturas").select("asignatura,resultados").eq("id", id).maybeSingle(),
      admin.from("evidencias").select("data").eq("user_id", user.id).order("created_at"),
    ]);
    if (!asig) throw new HttpError(404, "No encuentro tu acreditación en el catálogo.");
    // The browser says which outcomes still need evidence; only ids that exist in the official subject count.
    const pedidos = new Set((Array.isArray(body.resultados) ? body.resultados : []).map(String));
    const objetivo = asig.resultados.filter((r) => !pedidos.size || pedidos.has(r.id)).slice(0, 6);
    if (!objetivo.length) throw new HttpError(400, "No hay resultados de aprendizaje pendientes.");
    await chargeAiCall(user.id);
    const nuevos = (await recommendResources({ asignatura: asig.asignatura, resultados: objetivo, evidencias: rows.map((r) => r.data) }))
      .map((r) => ({ ...r, id: randomUUID(), estado: "pendiente" }));

    const anteriores = (perfil.recursos?.asignatura_id === id ? perfil.recursos.items || [] : []).filter((r) => r.estado !== "pendiente");
    const usados = new Set(anteriores.map((r) => r.url));
    const recursos = { asignatura_id: id, generado: new Date().toISOString(), items: [...nuevos.filter((r) => !usados.has(r.url)), ...anteriores] };
    const { error } = await admin.from("perfiles").update({ recursos }).eq("user_id", user.id);
    if (error) throw new HttpError(500, "No se pudieron guardar las recomendaciones. ¿Está aplicada la migración 006 en Supabase?");
    res.status(200).json({ recursos, nuevos: nuevos.length });
  } catch (err) {
    sendError(res, err);
  }
}
