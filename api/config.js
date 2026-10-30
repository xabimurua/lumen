// GET /api/config — public Supabase settings for the browser (the anon key is public by design).
import { allowMethods, publicConfig, sendError } from "../lib/server.js";

export default function handler(req, res) {
  if (!allowMethods(req, res, ["GET"])) return;
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(publicConfig());
  } catch (err) {
    sendError(res, err);
  }
}
