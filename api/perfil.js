// POST /api/perfil — brings the profile photo and name from the LinkedIn account the person has just linked
// (Sign In with LinkedIn, OpenID Connect). LinkedIn's image is downloaded here, because its servers don't let
// browsers read it, and stored as a small image in the profile.
import { adminClient, allowMethods, readJson, requireUser, sendError, HttpError } from "../lib/server.js";
import { fetchPublic } from "../lib/web.js";

const MAX_AVATAR_BYTES = 280 * 1024;

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const body = readJson(req);
    if (body.accion !== "linkedin") throw new HttpError(400, "Acción desconocida.");
    const admin = adminClient();
    const { data, error } = await admin.auth.admin.getUserById(user.id);
    if (error || !data?.user) throw new HttpError(500, "No se pudo leer tu cuenta.");
    const li = (data.user.identities || []).find((i) => i.provider === "linkedin_oidc");
    if (!li) throw new HttpError(409, "Tu cuenta de Lumen no está conectada con LinkedIn.");
    const d = li.identity_data || {};

    let avatar = "";
    if (typeof d.picture === "string" && /^https:\/\//.test(d.picture)) {
      try {
        const { type, bytes } = await fetchPublic(d.picture, "image/*");
        const mime = (type.split(";")[0] || "").trim();
        if (/^image\/(jpeg|png|webp|gif)$/.test(mime) && bytes.length > 0 && bytes.length <= MAX_AVATAR_BYTES) avatar = `data:${mime};base64,${bytes.toString("base64")}`;
      } catch (e) { console.error("linkedin picture", e?.message); }
    }
    const nombre = String(d.name || [d.given_name, d.family_name].filter(Boolean).join(" ")).trim().slice(0, 120);

    const { data: perfil, error: pErr } = await admin.from("perfiles").select("nombre, ficha").eq("user_id", user.id).single();
    if (pErr) throw new HttpError(500, "No se pudo leer tu perfil.");
    const patch = { ficha: { ...(perfil.ficha || {}), linkedin: { conectado: true, nombre, importado: new Date().toISOString() } } };
    if (avatar) patch.avatar = avatar;
    if (nombre && !perfil.nombre) patch.nombre = nombre;
    const { error: uErr } = await admin.from("perfiles").update(patch).eq("user_id", user.id);
    if (uErr) throw new HttpError(500, "No se pudo guardar tu perfil. Revisa que la base de datos esté actualizada (008_perfil.sql).");
    res.status(200).json({ avatar, nombre, foto: !!avatar });
  } catch (err) {
    sendError(res, err);
  }
}
