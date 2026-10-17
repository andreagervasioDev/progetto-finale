/**
 * Controllo del contenuto reale dei file caricati, prima di qualsiasi elaborazione.
 *
 * L'estensione la sceglie chi carica il file, quindi non basta: qui si guardano i primi byte
 * ("firma" del formato) e, per i formati che sono archivi zip (.docx, .xlsx), l'indice dell'archivio,
 * per rifiutare gli "zip bomb": file piccoli che una volta decompressi occupano gigabyte e
 * bloccano il server (mammoth e openpyxl decomprimono tutto in memoria).
 */
import fs from "node:fs/promises";

/** Errore "atteso": file rifiutato, il messaggio va mostrato all'utente. */
export class UnsafeFileError extends Error {
  status = 422;
}

// limiti per gli archivi zip (.docx / .xlsx). Misurati su file reali: un Excel molto ripetitivo
// arriva a ~15:1, un Word a ~2:1, uno zip bomb supera 1000:1.
export const ZIP_LIMITS = {
  maxEntries: 5000, // un documento normale ha poche decine di file interni
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MB decompressi in totale
  maxRatio: 100, // un rapporto di compressione oltre 100:1 è tipico degli zip bomb...
  ratioMinBytes: 10 * 1024 * 1024, // ...ma conta solo sopra i 10 MB decompressi (un file minuscolo è innocuo)
};

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // vecchio formato Office (.xls)
const PDF_SIGNATURE = Buffer.from("%PDF-");

const TEXT_TYPES = new Set([".txt", ".md", ".csv"]);
const ZIP_TYPES = new Set([".docx", ".xlsx"]);

const LABELS = { ".pdf": "PDF", ".docx": "Word", ".xlsx": "Excel", ".xls": "Excel", ".txt": "testo", ".md": "Markdown", ".csv": "CSV" };
const mismatch = (ext) => new UnsafeFileError(`Il contenuto del file non corrisponde a un ${LABELS[ext] ?? ext}: forse l'estensione è stata cambiata.`);

/** Primi `n` byte del file. */
async function readHead(filePath, n) {
  const handle = await fs.open(filePath, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Indice di un archivio zip (central directory), letto senza decomprimere nulla.
 * @returns {{ entries: number, compressed: number, uncompressed: number }}
 */
export function inspectZip(buffer) {
  // il record finale ("end of central directory") sta negli ultimi 22 byte + eventuale commento (max 64 KB)
  const minStart = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnsafeFileError("Archivio non valido: il file sembra danneggiato.");

  const entries = buffer.readUInt16LE(eocd + 10);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  // valori al massimo = formato ZIP64, usato solo per archivi enormi: non serve a un documento d'ufficio
  if (entries === 0xffff || dirOffset === 0xffffffff) {
    throw new UnsafeFileError("Archivio troppo grande o in formato non supportato.");
  }

  let compressed = 0;
  let uncompressed = 0;
  let pos = dirOffset;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new UnsafeFileError("Archivio non valido: il file sembra danneggiato.");
    }
    const csize = buffer.readUInt32LE(pos + 20);
    const usize = buffer.readUInt32LE(pos + 24);
    if (csize === 0xffffffff || usize === 0xffffffff) {
      throw new UnsafeFileError("Archivio troppo grande o in formato non supportato.");
    }
    compressed += csize;
    uncompressed += usize;
    // header di lunghezza fissa (46 byte) + nome del file + campo extra + commento
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return { entries, compressed, uncompressed };
}

/** Rifiuta gli archivi che si espandono in modo anomalo. */
export function assertSafeZip({ entries, compressed, uncompressed }, limits = ZIP_LIMITS) {
  if (entries > limits.maxEntries) {
    throw new UnsafeFileError("Il file contiene troppi elementi interni: è stato rifiutato per sicurezza.");
  }
  if (uncompressed > limits.maxUncompressedBytes) {
    throw new UnsafeFileError("Il file, una volta decompresso, sarebbe troppo grande: è stato rifiutato per sicurezza.");
  }
  if (uncompressed > limits.ratioMinBytes && compressed > 0 && uncompressed / compressed > limits.maxRatio) {
    throw new UnsafeFileError("Il file ha un rapporto di compressione anomalo (possibile zip bomb): è stato rifiutato per sicurezza.");
  }
}

/**
 * Verifica che il contenuto del file corrisponda all'estensione.
 * @throws {UnsafeFileError} se il file va rifiutato
 */
export async function verifyFileContent(filePath, ext) {
  if (ext === ".pdf") {
    // la firma può essere preceduta da qualche byte (alcuni generatori lo fanno): la cerco nel primo KB
    if (!(await readHead(filePath, 1024)).includes(PDF_SIGNATURE)) throw mismatch(ext);
    return;
  }
  if (ZIP_TYPES.has(ext)) {
    if (!(await readHead(filePath, 4)).equals(ZIP_SIGNATURE)) throw mismatch(ext);
    // il file è già limitato a 20 MB dall'upload: leggerlo intero per l'indice è sicuro
    assertSafeZip(inspectZip(await fs.readFile(filePath)));
    return;
  }
  if (ext === ".xls") {
    if (!(await readHead(filePath, 8)).equals(OLE_SIGNATURE)) throw mismatch(ext);
    return;
  }
  if (TEXT_TYPES.has(ext)) {
    // un file di testo non contiene byte nulli: se ci sono, è un binario con l'estensione cambiata
    if ((await readHead(filePath, 64 * 1024)).includes(0)) throw mismatch(ext);
  }
}
