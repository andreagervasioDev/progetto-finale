/**
 * Chunking "markdown-aware" per la knowledge base.
 *
 * 1. Il documento viene diviso per sezioni (titoli ## e ###), così ogni chunk
 *    resta semanticamente coerente e porta con sé il percorso dei titoli.
 * 2. Le sezioni troppo lunghe vengono spezzate per paragrafi con una piccola
 *    sovrapposizione, per non perdere il contesto al confine tra due chunk.
 */

const MAX_CHARS = 1400;
const OVERLAP_CHARS = 200;

/** Spezza un paragrafo troppo lungo per frasi (o righe), e in ultima istanza a lunghezza fissa. */
function splitParagraph(p) {
  if (p.length <= MAX_CHARS) return [p];
  const units = p.split(/(?<=[.!?;:])\s+|\n/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const u of units) {
    if (u.length > MAX_CHARS) {
      if (cur) out.push(cur), (cur = "");
      for (let i = 0; i < u.length; i += MAX_CHARS) out.push(u.slice(i, i + MAX_CHARS));
    } else if (cur && (cur + " " + u).length > MAX_CHARS) {
      out.push(cur);
      cur = u;
    } else {
      cur = cur ? cur + " " + u : u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function splitLongText(text) {
  if (text.length <= MAX_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/).flatMap(splitParagraph);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && (current + "\n\n" + p).length > MAX_CHARS) {
      chunks.push(current);
      // sovrapposizione: l'ultima parte del chunk precedente apre il successivo
      const overlap = current.slice(-OVERLAP_CHARS);
      current = (overlap + "\n\n" + p).length <= MAX_CHARS + OVERLAP_CHARS ? overlap + "\n\n" + p : p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function chunkMarkdown(markdown, source) {
  const lines = markdown.split("\n");
  const docTitle = (lines.find((l) => l.startsWith("# ")) || source).replace(/^#\s+/, "").trim();

  const sections = [];
  let h2 = "";
  let h3 = "";
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ section: [h2, h3].filter(Boolean).join(" › ") || "Introduzione", body });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      flush();
      h2 = line.replace(/^##\s+/, "").trim();
      h3 = "";
    } else if (line.startsWith("### ")) {
      flush();
      h3 = line.replace(/^###\s+/, "").trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const { section, body } of sections) {
    splitLongText(body).forEach((part, i) => {
      chunks.push({
        id: `${source}::${chunks.length}`,
        // titolo e sezione dentro il testo embeddato migliorano il retrieval
        text: `${docTitle}\nSezione: ${section}\n\n${part}`,
        metadata: { source, title: docTitle, section, part: i },
      });
    });
  }
  return chunks;
}

/**
 * Chunking per testo semplice (PDF, Word, TXT): si spezza per paragrafi pagina per pagina,
 * così ogni fonte può citare il numero di pagina.
 * @param {{num: number|null, text: string}[]} pages
 */
export function chunkPlainText(pages, { title }) {
  const chunks = [];
  for (const { num, text } of pages) {
    const clean = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) continue;
    splitLongText(clean).forEach((part, i) => {
      const section = num ? `Pagina ${num}` : `Parte ${chunks.length + 1}`;
      chunks.push({
        text: `${title}\nSezione: ${section}\n\n${part}`,
        metadata: { title, section, page: num ?? 0, part: i },
      });
    });
  }
  return chunks;
}
