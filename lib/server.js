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
  const { GOOGLE_CLIENT_ID, GOOGLE_API_KEY, GOOGLE_APP_ID } = process.env;
  // Google Drive picker settings are public by design (they identify the app, they don't grant access).
  const google = GOOGLE_CLIENT_ID && GOOGLE_API_KEY && GOOGLE_APP_ID ? { clientId: GOOGLE_CLIENT_ID, apiKey: GOOGLE_API_KEY, appId: GOOGLE_APP_ID } : null;
  return { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, google };
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
  if (error) {
    console.error("registrar_uso_ia", error);
    throw new HttpError(500, `No se pudo registrar el uso de la IA en la base de datos (${error.code || "error"}). Revisa que el esquema de Supabase esté completo.`);
  }
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

/** Turns an Anthropic API error into a message that says what to fix, without exposing keys or internals. */
function describeAiError(err) {
  const detail = String(err?.error?.error?.message || err?.message || "");
  if (err.status === 401) return new HttpError(502, "La clave de la IA (ANTHROPIC_API_KEY) no es válida. Revísala en Vercel.");
  if (/credit balance|billing|spend limit/i.test(detail)) return new HttpError(502, "La cuenta de Anthropic no tiene saldo o ha llegado a su límite de gasto. Revísalo en platform.claude.com → Billing.");
  if (/web.?(search|fetch)/i.test(detail)) return new HttpError(502, "La búsqueda o la lectura de páginas web no está activada en la cuenta de Anthropic. Actívala en la configuración de la organización en platform.claude.com.");
  if (err.status === 403) return new HttpError(502, "La cuenta de Anthropic no tiene permiso para usar este modelo o función.");
  if (err.status === 404) return new HttpError(502, "El modelo de IA configurado no está disponible para esta cuenta de Anthropic.");
  if (err.status === 429) return new HttpError(503, "La IA está recibiendo demasiadas peticiones. Inténtalo en un minuto.");
  if (err.status >= 500) return new HttpError(503, "La IA está saturada o no responde. Inténtalo en unos minutos.");
  return new HttpError(502, `La IA rechazó la petición: ${detail.slice(0, 200)}`);
}

export function sendError(res, err) {
  if (!(err instanceof HttpError) && typeof err?.status === "number" && err?.error !== undefined) {
    console.error(err);
    err = describeAiError(err);
  }
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

/**
 * Learning outcomes the AI works with: those of one of the participant's accreditations (read from the official
 * catalog, never from the browser), or none when the conversation is not tied to an accreditation.
 */
export async function objetivoDe(userId, acreditacionId) {
  if (!acreditacionId) return { generico: false, resultados: [] };
  const { data, error } = await adminClient().from("acreditaciones").select("asignatura_id, catalogo_asignaturas(id, asignatura, titulacion, universidad, nivel, ects, resultados, fuente_url, estado)").eq("id", String(acreditacionId)).eq("user_id", userId).maybeSingle();
  if (error || !data?.catalogo_asignaturas) throw new HttpError(404, "No encuentro esa acreditación.");
  const a = data.catalogo_asignaturas;
  return { ...a, asignatura_id: data.asignatura_id, generico: false };
}
