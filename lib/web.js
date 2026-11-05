// Safe fetching of public web pages and documents shared by participants or coordinators.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./server.js";

const MAX_BYTES = 12 * 1024 * 1024;
export const MAX_CHARS = 150_000;

function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Only public http(s) addresses on default ports, so a shared link can never reach internal services. */
export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, "El enlace no es válido."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new HttpError(400, "Solo puedo leer enlaces web normales (http o https).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new HttpError(400, "No puedo leer ese enlace.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new HttpError(400, "No encuentro esa dirección web."); });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "No puedo leer ese enlace.");
  return url;
}

/** Fetches a public URL (following safe redirects) and returns its bytes, decoded text and content type. */
export async function fetchPublic(raw, accept) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: "manual", headers: { Accept: accept, "User-Agent": "LumenBot/1.0 (+lectura de enlaces compartidos por participantes)" }, signal: AbortSignal.timeout(8000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(422, "La página no se pudo abrir.");
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return { url, type: res.headers.get("content-type") || "", bytes, body: bytes.toString("utf8") };
  }
  throw new HttpError(422, "La página redirige demasiadas veces.");
}

export const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
export const meta = (html, name) => decode(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)`, "i"))?.[1] || "").trim();

export function readableText(html) {
  const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
  return decode(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|section|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

