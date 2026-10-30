// Shared server helpers: Supabase admin client, auth, consent and usage limits.
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
export const DAILY_AI_LIMIT = Number(process.env.LUMEN_DAILY_AI_LIMIT || 120);

let admin;
export function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, "Falta configurar Supabase en el servidor.");
  admin ??= createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function publicConfig() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new HttpError(500, "Falta configurar Supabase en el servidor.");
  return { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY };
}

/** Resolves the signed-in user from the Bearer token, or throws 401. */
export async function requireUser(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Inicia sesión para continuar.");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Tu sesión ha caducado. Vuelve a iniciar sesión.");
  return data.user;
}

/** Loads the participant's profile and checks informed consent. */
export async function requireConsentedProfile(userId) {
  const { data, error } = await adminClient().from("perfiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(500, "No se pudo leer tu perfil.");
  if (!data?.consentimiento_at) throw new HttpError(403, "Antes de usar la IA tienes que aceptar el consentimiento informado.");
  return data;
}

/** Counts one AI call for today; throws 429 past the daily limit. */
export async function chargeAiCall(userId) {
  const { data, error } = await adminClient().rpc("registrar_uso_ia", { p_user: userId, p_limite: DAILY_AI_LIMIT });
  if (error) throw new HttpError(500, "No se pudo registrar el uso de la IA.");
  if (data !== true) throw new HttpError(429, "Has alcanzado el límite diario de uso de la IA. Mañana podrás seguir.");
}

export function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    throw new HttpError(400, "La petición no es JSON válido.");
  }
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: err instanceof HttpError ? err.message : "Error interno. Inténtalo de nuevo." });
  else res.end();
}

export function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).json({ error: "Método no permitido." });
  return false;
}
