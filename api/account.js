// DELETE /api/account — erases the participant's files, records and login (right to erasure).
import { adminClient, allowMethods, requireUser, sendError, HttpError } from "../lib/server.js";

const BUCKET = "artefactos";

async function removeFolder(admin, prefix) {
  for (;;) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 100 });
    if (error) throw new HttpError(500, "No se pudieron borrar tus archivos.");
    if (!data.length) return;
    const files = data.filter((f) => f.id).map((f) => `${prefix}/${f.name}`);
    const folders = data.filter((f) => !f.id).map((f) => `${prefix}/${f.name}`);
    for (const folder of folders) await removeFolder(admin, folder);
    if (files.length) {
      const { error: rmError } = await admin.storage.from(BUCKET).remove(files);
      if (rmError) throw new HttpError(500, "No se pudieron borrar tus archivos.");
    }
    if (data.length < 100 && !folders.length) return;
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["DELETE"])) return;
  try {
    const user = await requireUser(req);
    const admin = adminClient();
    await removeFolder(admin, user.id);
    // perfiles, evidencias and uso_ia cascade from auth.users
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new HttpError(500, "No se pudo eliminar la cuenta.");
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
}
