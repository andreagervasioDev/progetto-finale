/**
 * Controllo del contenuto dei file caricati: la firma deve corrispondere all'estensione e gli
 * archivi zip (.docx / .xlsx) non devono espandersi in modo anomalo (zip bomb).
 * Gli archivi di prova sono costruiti in memoria, con un writer zip minimale (metodo "store").
 */
import { TEST_STORAGE } from "./env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { ZIP_LIMITS, UnsafeFileError, assertSafeZip, inspectZip, verifyFileContent } from "../src/documents/fileCheck.js";

/** Archivio zip minimale non compresso; `declaredSize` permette di simulare dimensioni decompresse enormi. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, declaredSize } of files) {
    const nameBuf = Buffer.from(name);
    const usize = declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(data.length, 20); // dimensione compressa
    header.writeUInt32LE(usize, 24); // dimensione decompressa
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function tmpFile(name, content) {
  const file = path.join(TEST_STORAGE, name);
  fs.writeFileSync(file, content);
  return file;
}

const rejects = (file, ext, pattern) =>
  assert.rejects(verifyFileContent(file, ext), (err) => err instanceof UnsafeFileError && pattern.test(err.message));

describe("firma del formato", () => {
  test("un PDF vero è accettato, un eseguibile rinominato .pdf no", async () => {
    await verifyFileContent(tmpFile("vero.pdf", "%PDF-1.7\n1 0 obj\n"), ".pdf");
    await rejects(tmpFile("falso.pdf", Buffer.from([0x4d, 0x5a, 0x90, 0x00])), ".pdf", /non corrisponde a un PDF/);
  });

  test("un .docx deve essere un archivio zip", async () => {
    await verifyFileContent(tmpFile("vero.docx", makeZip([{ name: "word/document.xml", data: Buffer.from("<w:document/>") }])), ".docx");
    await rejects(tmpFile("falso.docx", "testo normale, non un archivio"), ".docx", /non corrisponde a un Word/);
  });

  test("un .xls deve avere la firma del vecchio formato Office", async () => {
    await verifyFileContent(tmpFile("vero.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), ".xls");
    await rejects(tmpFile("falso.xls", "a,b\n1,2\n"), ".xls", /non corrisponde a un Excel/);
  });

  test("CSV, TXT e Markdown non devono contenere byte nulli (binari rinominati)", async () => {
    await verifyFileContent(tmpFile("vero.csv", "Giocatore;Ingaggio\nRossi;€ 1.200.000\n"), ".csv");
    await verifyFileContent(tmpFile("vero.md", "# Regolamento\n\nTesto con accenti: è, à, ù."), ".md");
    await rejects(tmpFile("falso.csv", Buffer.from("a,b\n\0\0\0")), ".csv", /non corrisponde a un CSV/);
  });
});

describe("zip bomb", () => {
  test("legge numero di elementi e dimensioni dall'indice senza decomprimere", () => {
    const zip = makeZip([
      { name: "a.xml", data: Buffer.from("x".repeat(100)) },
      { name: "b.xml", data: Buffer.from("y".repeat(50)) },
    ]);
    assert.deepEqual(inspectZip(zip), { entries: 2, compressed: 150, uncompressed: 150 });
  });

  test("rifiuta un archivio che si espande oltre il limite totale", async () => {
    const bomba = makeZip([{ name: "word/media/x.bin", data: Buffer.from("0"), declaredSize: ZIP_LIMITS.maxUncompressedBytes + 1 }]);
    await rejects(tmpFile("bomba.docx", bomba), ".docx", /troppo grande/);
  });

  test("rifiuta un rapporto di compressione anomalo sopra i 10 MB", () => {
    assert.throws(
      () => assertSafeZip({ entries: 3, compressed: 100_000, uncompressed: 50 * 1024 * 1024 }),
      (err) => err instanceof UnsafeFileError && /zip bomb/.test(err.message),
    );
  });

  test("un file piccolo con rapporto alto è innocuo e passa", () => {
    assertSafeZip({ entries: 3, compressed: 2_000, uncompressed: 300_000 }); // 150:1 ma solo 300 KB
  });

  test("un Excel molto ripetitivo (circa 15:1) passa", () => {
    assertSafeZip({ entries: 10, compressed: 1_000_000, uncompressed: 15_000_000 });
  });

  test("rifiuta troppi elementi interni", () => {
    assert.throws(() => assertSafeZip({ entries: ZIP_LIMITS.maxEntries + 1, compressed: 1, uncompressed: 1 }), /troppi elementi/);
  });

  test("un archivio danneggiato viene rifiutato con un messaggio chiaro", () => {
    assert.throws(() => inspectZip(Buffer.from("PK\x03\x04 troncato")), /danneggiato/);
  });
});
