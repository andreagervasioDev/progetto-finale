/**
 * Estrazione del testo dai documenti caricati.
 *   - PDF  → testo pagina per pagina (pdf-parse), così le fonti citano la pagina
 *   - DOCX → testo semplice per l'indicizzazione, HTML per la lettura (mammoth)
 *   - MD / TXT → testo così com'è
 *   - CSV / Excel → non vengono letti qui: sono dataset, analizzati dal data agent Python
 */
import fs from "node:fs/promises";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sanitizeHtml from "sanitize-html";

/**
 * Pulizia dell'HTML generato da mammoth a partire dal .docx, prima di mostrarlo nel lettore
 * con dangerouslySetInnerHTML. Un documento Word non è fidato (può arrivare da chiunque), quindi
 * si tiene solo una whitelist di tag e attributi di formattazione: niente <script>, niente gestori
 * di eventi (onclick...), niente sorgenti pericolose. mammoth produce solo formattazione testuale,
 * perciò questa lista copre tutto il suo output legittimo.
 */
const DOCX_SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "span", "div",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a",
    "table", "thead", "tbody", "tr", "th", "td",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  // link solo http/https/mailto: esclude javascript:, vbscript:, ecc.
  allowedSchemes: ["http", "https", "mailto"],
  // mammoth incorpora le immagini del .docx come "data:image/...;base64,...": ammesse
  // le immagini vere (http/https e data:image), mai data:text/html che potrebbe contenere script
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  // i link esterni si aprono in una nuova scheda senza dare accesso alla pagina (noopener)
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
  // scarta le <img> il cui src è un data: non-immagine (es. data:text/html)
  exclusiveFilter: (frame) =>
    frame.tag === "img" &&
    /^data:/i.test(frame.attribs.src || "") &&
    !/^data:image\//i.test(frame.attribs.src || ""),
  disallowedTagsMode: "discard",
};

/** Ripulisce l'HTML di un documento Word tenendo solo la formattazione sicura. */
export function sanitizeDocxHtml(html) {
  return sanitizeHtml(html, DOCX_SANITIZE_OPTIONS);
}

export const SUPPORTED_TYPES = {
  ".pdf": { label: "PDF", mime: "application/pdf" },
  ".docx": { label: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".md": { label: "Markdown", mime: "text/markdown; charset=utf-8" },
  ".txt": { label: "Testo", mime: "text/plain; charset=utf-8" },
  ".csv": { label: "CSV", mime: "text/csv; charset=utf-8", tabular: true },
  ".xlsx": { label: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", tabular: true },
  ".xls": { label: "Excel", mime: "application/vnd.ms-excel", tabular: true },
};

export const isTabular = (ext) => Boolean(SUPPORTED_TYPES[ext]?.tabular);

/** @returns {Promise<{ pages: {num: number|null, text: string}[], markdown: boolean }>} */
export async function extractText(filePath, ext) {
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: await fs.readFile(filePath) });
    try {
      const result = await parser.getText();
      return { pages: result.pages.map((p) => ({ num: p.num, text: p.text })), markdown: false };
    } finally {
      await parser.destroy();
    }
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return { pages: [{ num: null, text: value }], markdown: false };
  }
  const text = await fs.readFile(filePath, "utf8");
  return { pages: [{ num: null, text }], markdown: ext === ".md" };
}

/** Contenuto per il lettore nel frontend. */
export async function readableContent(filePath, ext) {
  if (isTabular(ext)) return { format: "dataset" };
  if (ext === ".pdf") return { format: "pdf" };
  if (ext === ".docx") {
    const { value } = await mammoth.convertToHtml({ path: filePath });
    // l'HTML di un documento Word non è fidato: lo ripulisco con un sanitizer (whitelist di tag/attributi)
    return { format: "html", content: sanitizeDocxHtml(value) };
  }
  const text = await fs.readFile(filePath, "utf8");
  return { format: ext === ".md" ? "markdown" : "text", content: text };
}
