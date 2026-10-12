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
    // il testo è già "escapato" da mammoth; neutralizzo eventuali link javascript:/data: nei collegamenti
    const safe = value.replace(/\b(href|src)\s*=\s*"\s*(javascript|vbscript|data:text)[^"]*"/gi, '$1="#"');
    return { format: "html", content: safe };
  }
  const text = await fs.readFile(filePath, "utf8");
  return { format: ext === ".md" ? "markdown" : "text", content: text };
}
