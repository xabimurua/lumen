// Research pipeline that loads a person's experience: reads their CV, searches the web for their public
// track record, and looks for public sources that back each experience. Every step reports progress.
import { z } from "zod";
import { BETAS, client, jsonCall, MODEL } from "./claude.js";
import { HttpError } from "./server.js";

export const TIPOS_TRAYECTORIA = ["Trabajo", "Emprendimiento", "Proyecto", "Voluntariado", "Formación", "Publicación", "Premio o reconocimiento", "Charla o evento", "Otro"];
const str = { type: "string" };
const strs = { type: "array", items: str };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(s\.?l\.?u?|s\.?a\.?|s\.?coop\.?|fundacion|asociacion|universidad|the)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * One web research conversation. It streams so that each search and each page read is reported through
 * `onStep` while it happens. Returns the written report and every page that turned up.
 */
async function webResearch({ prompt, searches, fetches = 0, effort = "medium", onStep }) {
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: searches, user_location: { type: "approximate", country: "ES" } }];
  if (fetches) tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: fetches });
  const messages = [{ role: "user", content: prompt }];
  let content = [];
  for (let i = 0; i < 5; i++) {
    const stream = client.beta.messages.stream({ model: MODEL, max_tokens: 16000, betas: BETAS, fallbacks: "default", output_config: { effort }, tools, messages });
    stream.on("contentBlock", (b) => {
      if (b.type !== "server_tool_use") return;
      if (b.name === "web_search" && b.input?.query) onStep?.(`Buscando «${String(b.input.query).slice(0, 90)}»`);
      if (b.name === "web_fetch" && b.input?.url) onStep?.(`Leyendo ${hostOf(b.input.url)}`);
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") break;
    content = content.concat(response.content);
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  const informe = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const fuentes = new Map();
  for (const b of content) {
    if (b.type === "text") for (const c of b.citations || []) if (c.url) fuentes.set(c.url, c.title || c.url);
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) fuentes.set(r.url, r.title || r.url);
    if (b.type === "web_fetch_tool_result" && b.content && !Array.isArray(b.content) && b.content.url) fuentes.set(b.content.url, b.content.content?.title || b.content.url);
  }
  return { informe, fuentes };
}

const itemProps = {
  titulo: str,
  tipo: { type: "string", enum: TIPOS_TRAYECTORIA },
  organizacion: str, rol: str,
  fecha_inicio: { type: "string", description: "AAAA o AAAA-MM; vacío si no se sabe" },
  fecha_fin: { type: "string", description: "AAAA o AAAA-MM; vacío si sigue o no se sabe" },
  descripcion: str,
  logros: strs,
  competencias: strs,
};
const itemZ = { titulo: z.string(), tipo: z.string(), organizacion: z.string(), rol: z.string(), fecha_inicio: z.string(), fecha_fin: z.string(), descripcion: z.string(), logros: z.array(z.string()), competencias: z.array(z.string()) };
const cleanItem = (x) => ({
  titulo: x.titulo.trim().slice(0, 160), tipo: TIPOS_TRAYECTORIA.includes(x.tipo) ? x.tipo : "Otro", organizacion: x.organizacion.trim().slice(0, 160), rol: x.rol.trim().slice(0, 160),
  fecha_inicio: /^\d{4}(-\d{2})?$/.test(x.fecha_inicio) ? x.fecha_inicio : "", fecha_fin: /^\d{4}(-\d{2})?$/.test(x.fecha_fin) ? x.fecha_fin : "",
  descripcion: x.descripcion.trim().slice(0, 900), logros: x.logros.map((t) => t.trim()).filter(Boolean).slice(0, 5), competencias: x.competencias.map((t) => t.trim()).filter(Boolean).slice(0, 8),
});

/** Reads a CV or a LinkedIn profile exported as PDF and returns its experiences, copied faithfully. */
export async function extractCv({ doc }) {
  const out = await jsonCall({
    fuente: doc,
    effort: "medium",
    schema: {
      type: "object", additionalProperties: false, required: ["es_cv", "nombre", "pistas", "items"],
      properties: { es_cv: { type: "boolean" }, nombre: str, pistas: strs, items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(itemProps), properties: itemProps } } },
    },
    validator: z.object({ es_cv: z.boolean(), nombre: z.string(), pistas: z.array(z.string()), items: z.array(z.object(itemZ)) }),
    prompt: `El documento de arriba debería ser el currículum de una persona o su perfil de LinkedIn exportado. Extrae TODA su trayectoria, sin resumirla en pocas líneas y sin inventar nada que no esté en el documento.

- es_cv: false si el documento no es un currículum ni un perfil profesional.
- nombre: el nombre de la persona tal como aparece.
- pistas: de 3 a 8 datos que la identifican frente a homónimos (ciudad, sector, organizaciones principales, especialidad).
- items: una entrada por cada experiencia, de la más reciente a la más antigua (máximo 30): cada trabajo o cargo, empresa o proyecto creado, voluntariado, formación (títulos, cursos, certificaciones), publicación, premio y charla.
  - titulo: máximo 10 palabras, con el papel y la organización (por ejemplo «Cofundador y director de Osoigo»).
  - descripcion: 1-3 frases sobre lo que hizo, con las palabras del documento.
  - logros: resultados concretos o cifras que cite el documento (lista vacía si no hay).
  - competencias: lo que esa experiencia demuestra que sabe hacer, según el documento (de 2 a 6, en infinitivo: «Coordinar equipos», «Analizar datos de ventas»).
  - fechas en formato AAAA o AAAA-MM.`,
  });
  return { es_cv: out.es_cv, nombre: out.nombre.trim(), pistas: out.pistas.map((p) => p.trim()).filter(Boolean).slice(0, 8), items: out.items.slice(0, 30).map(cleanItem) };
}

/** Searches the web for the person's public track record. `conocidas` are experiences already known from their CV. */
export async function traceRecord({ nombre, pistas, enlaces, conocidas = [], onStep }) {
  const { informe, fuentes } = await webResearch({
    searches: 12, fetches: 8, onStep,
    prompt: `Una persona te pide que busques en internet su propia trayectoria pública para documentar sus aprendizajes y pedir un reconocimiento universitario. Ha dado su consentimiento.

Nombre: ${nombre}
Pistas para identificarla: ${pistas || "(ninguna)"}
Enlaces propios: ${enlaces.length ? enlaces.join(" , ") : "(ninguno)"}
${conocidas.length ? `Experiencias que ya constan en su CV (úsalas para identificarla y para buscar más detalle, no hace falta repetirlas tal cual):\n${conocidas.map((c) => `- ${c.titulo}${c.organizacion ? " · " + c.organizacion : ""}`).join("\n")}\n` : ""}
Investiga a fondo, con búsquedas variadas:
- el nombre entre comillas, solo y combinado con cada pista y con cada organización;
- variantes del nombre (con uno o dos apellidos, en euskera, catalán o gallego si procede);
- entrevistas, noticias y notas de prensa; ponencias y congresos; publicaciones, libros y artículos; premios; registros mercantiles y directorios de empresas o startups; perfiles en webs de programas, aceleradoras, asociaciones y universidades.
Abre con web_fetch sus enlaces propios y las páginas más relevantes para sacar detalle (fechas, cargos, cifras, hitos).
Usa las pistas para no confundirla con otras personas con el mismo nombre y descarta lo que claramente sea de otra persona.

Escribe después un informe en español con cada experiencia encontrada: qué fue, su papel, organización, fechas aproximadas, logros o cifras que citen las fuentes, y qué fuentes la respaldan. Indica cuando no estés seguro de que se trate de la misma persona. Si no encuentras nada fiable, dilo.`,
  });
  for (const u of enlaces) if (!fuentes.has(u)) fuentes.set(u, u);
  if (!informe || !fuentes.size) return [];
  const urls = [...fuentes.keys()].slice(0, 80);
  onStep?.("Ordenando lo que he encontrado en internet");
  const props = { ...itemProps, fuentes: { type: "array", items: { type: "string", enum: urls } }, confianza: { type: "string", enum: ["alta", "media", "baja"] }, motivo_confianza: str };
  const out = await jsonCall({
    effort: "low",
    schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(props), properties: props } } } },
    validator: z.object({ items: z.array(z.object({ ...itemZ, fuentes: z.array(z.string()), confianza: z.string(), motivo_confianza: z.string() })) }),
    prompt: `Convierte este informe sobre la trayectoria pública de ${nombre} en una lista de experiencias (máximo 25, de la más reciente a la más antigua). Usa solo lo que dice el informe.
- titulo: máximo 10 palabras. descripcion: 1-3 frases sobre qué hizo, según las fuentes.
- logros: resultados o cifras que citen las fuentes. competencias: lo que la experiencia demuestra que sabe hacer (2 a 6, en infinitivo).
- fuentes: las URL de la lista que respaldan esa experiencia (al menos una).
- confianza: alta si las fuentes la identifican claramente con esta persona; media si es probable; baja si podría ser otra persona con el mismo nombre. motivo_confianza: una frase.

Fuentes disponibles:
${urls.map((u) => `- ${u} (${fuentes.get(u)})`).join("\n")}

Informe:
${informe.slice(0, 40000)}`,
  });
  return out.items.filter((x) => x.fuentes.some((u) => fuentes.has(u))).slice(0, 25).map((x) => ({
    ...cleanItem(x), confianza: ["alta", "media", "baja"].includes(x.confianza) ? x.confianza : "media", motivo_confianza: x.motivo_confianza.trim().slice(0, 300),
    fuentes: x.fuentes.filter((u) => fuentes.has(u)).slice(0, 5).map((u) => ({ url: u, titulo: String(fuentes.get(u)).slice(0, 160) })),
  }));
}

/** Looks for public sources that back experiences taken from a CV. Returns, per item index, sources and context. */
export async function corroborate({ nombre, items, onStep }) {
  if (!items.length) return [];
  const { informe, fuentes } = await webResearch({
    searches: Math.min(12, items.length * 2), effort: "low", onStep,
    prompt: `${nombre} ha subido su currículum para un expediente de reconocimiento universitario. Busca en internet fuentes públicas que respalden estas experiencias:

${items.map((x, i) => `${i + 1}. ${x.titulo}${x.organizacion ? ` · ${x.organizacion}` : ""}${x.fecha_inicio ? ` · ${x.fecha_inicio}${x.fecha_fin ? "–" + x.fecha_fin : ""}` : ""}`).join("\n")}

Para cada una, busca la web de la organización o del proyecto, noticias, registros o páginas donde aparezca, y sobre todo páginas que nombren a ${nombre} en relación con ella. Escribe un informe breve, experiencia por experiencia (con su número): qué es la organización o el proyecto en una frase, qué fuentes lo respaldan y si alguna nombra a la persona. Si de alguna no encuentras nada, dilo.`,
  });
  if (!informe || !fuentes.size) return [];
  const urls = [...fuentes.keys()].slice(0, 80);
  const out = await jsonCall({
    effort: "low",
    schema: {
      type: "object", additionalProperties: false, required: ["resultados"],
      properties: { resultados: { type: "array", items: { type: "object", additionalProperties: false, required: ["numero", "fuentes", "contexto", "nombra_a_la_persona"], properties: { numero: { type: "integer" }, fuentes: { type: "array", items: { type: "string", enum: urls } }, contexto: str, nombra_a_la_persona: { type: "boolean" } } } } },
    },
    validator: z.object({ resultados: z.array(z.object({ numero: z.number(), fuentes: z.array(z.string()), contexto: z.string(), nombra_a_la_persona: z.boolean() })) }),
    prompt: `Extrae del informe, para cada experiencia numerada, las URL de la lista que la respaldan (ninguna si no hay), una frase de contexto sobre la organización o el proyecto, y si alguna fuente nombra a ${nombre}.

URL disponibles:
${urls.map((u) => `- ${u} (${fuentes.get(u)})`).join("\n")}

Informe:
${informe.slice(0, 30000)}`,
  });
  return out.resultados.filter((r) => r.numero >= 1 && r.numero <= items.length).map((r) => ({
    index: r.numero - 1, contexto: r.contexto.trim().slice(0, 300), nombra: r.nombra_a_la_persona,
    fuentes: r.fuentes.filter((u) => fuentes.has(u)).slice(0, 4).map((u) => ({ url: u, titulo: String(fuentes.get(u)).slice(0, 160) })),
  }));
}

const sameOrg = (a, b) => { const x = norm(a), y = norm(b); return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x)); };

/**
 * Full import: CV first (the most reliable source), then the web search and the search for public backing in
 * parallel, merged so that each experience appears once with everything known about it.
 */
export async function importExperience({ nombre, pistas, enlaces, cvDoc, web, onStep }) {
  let items = [], pistasCv = [];
  if (cvDoc) {
    onStep("Leyendo tu currículum");
    const cv = await extractCv({ doc: cvDoc });
    if (!cv.es_cv) throw new HttpError(422, "Ese documento no parece un currículum ni un perfil profesional.");
    pistasCv = cv.pistas;
    items = cv.items.map((x) => ({ ...x, origen: "cv", confianza: "alta", motivo_confianza: "Consta en el currículum que has subido.", fuentes: [] }));
    onStep(`He encontrado ${items.length} experiencias en tu currículum`);
  }
  if (web) {
    const todasLasPistas = [pistas, ...pistasCv].filter(Boolean).join(", ").slice(0, 900);
    onStep("Buscando tu trayectoria en internet");
    const soloWeb = !items.length;
    const [encontradas, respaldo] = await Promise.all([
      traceRecord({ nombre, pistas: todasLasPistas, enlaces, conocidas: items, onStep }).catch((e) => { if (soloWeb) throw e; console.error(e); onStep("La búsqueda en internet no ha respondido; sigo con tu currículum"); return []; }),
      corroborate({ nombre, items: items.slice(0, 12), onStep }).catch((e) => { console.error(e); return []; }),
    ]);
    for (const r of respaldo) {
      const x = items[r.index];
      if (!x || !r.fuentes.length) continue;
      x.fuentes = r.fuentes; x.contexto = r.contexto; x.origen = "cv+internet";
      x.motivo_confianza = r.nombra ? "Consta en tu currículum y hay fuentes públicas que te nombran." : "Consta en tu currículum y hay fuentes públicas sobre la organización.";
    }
    for (const w of encontradas) {
      const propia = w.organizacion && items.find((x) => x.origen !== "internet" && sameOrg(x.organizacion, w.organizacion));
      if (propia) {
        const ya = new Set(propia.fuentes.map((f) => f.url));
        propia.fuentes = [...propia.fuentes, ...w.fuentes.filter((f) => !ya.has(f.url))].slice(0, 6);
        propia.origen = "cv+internet";
        propia.logros = [...new Set([...propia.logros, ...w.logros])].slice(0, 6);
        propia.motivo_confianza = "Consta en tu currículum y lo respaldan fuentes públicas.";
      } else items.push({ ...w, origen: "internet" });
    }
    onStep(`Internet: ${encontradas.length} experiencias encontradas y ${items.filter((x) => x.origen === "cv+internet").length} de tu currículum con respaldo público`);
  }
  return items;
}
