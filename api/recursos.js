// POST /api/recursos — recommends real books, videos, articles, podcasts and courses for the learning
// outcomes of one of the participant's accreditations that still lack evidence.
import { randomUUID } from "node:crypto";
import { adminClient, allowMethods, chargeAiCall, objetivoDe, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { recommendResources } from "../lib/claude.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    await requireConsentedProfile(user.id);
    const body = readJson(req);
    if (!body.acreditacion_id) throw new HttpError(400, "Falta la acreditación.");
    const admin = adminClient();
    const asig = await objetivoDe(user.id, body.acreditacion_id);
    const [{ data: ac }, { data: rows }] = await Promise.all([
      admin.from("acreditaciones").select("recursos").eq("id", body.acreditacion_id).eq("user_id", user.id).single(),
      admin.from("evidencias").select("data").eq("user_id", user.id).order("created_at"),
    ]);
    // The browser says which outcomes still need evidence; only ids that exist in the official subject count.
    const pedidos = new Set((Array.isArray(body.resultados) ? body.resultados : []).map(String));
    const objetivo = asig.resultados.filter((r) => !pedidos.size || pedidos.has(r.id)).slice(0, 6);
    if (!objetivo.length) throw new HttpError(400, "No hay resultados de aprendizaje pendientes.");
    const evidencias = rows.map((r) => r.data).filter((e) => e.vinculos?.[body.acreditacion_id]?.length);
    await chargeAiCall(user.id);
    const nuevos = (await recommendResources({ asignatura: asig.asignatura, resultados: objetivo, evidencias }))
      .map((r) => ({ ...r, id: randomUUID(), estado: "pendiente" }));

    const anteriores = (ac?.recursos?.items || []).filter((r) => r.estado !== "pendiente");
    const usados = new Set(anteriores.map((r) => r.url));
    const recursos = { generado: new Date().toISOString(), items: [...nuevos.filter((r) => !usados.has(r.url)), ...anteriores] };
    const { error } = await admin.from("acreditaciones").update({ recursos }).eq("id", body.acreditacion_id).eq("user_id", user.id);
    if (error) throw new HttpError(500, "No se pudieron guardar las recomendaciones.");
    res.status(200).json({ recursos, nuevos: nuevos.length });
  } catch (err) {
    sendError(res, err);
  }
}
