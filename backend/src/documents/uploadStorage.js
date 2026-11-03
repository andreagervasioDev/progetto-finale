/**
 * Storage di multer per i file caricati: li scrive in una cartella temporanea, come `dest`, ma tiene un
 * riferimento al file in scrittura (req.uploadTemp). Così, se la ricezione viene interrotta perché il
 * file supera il limite, il file parziale si può chiudere e cancellare subito (discardUpload), senza
 * aspettare la fine della richiesta e senza lasciare file o descrittori aperti.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UPLOAD_DIR = path.join(os.tmpdir(), "managementai-uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const tempUploadStorage = {
  _handleFile(req, file, cb) {
    const filename = randomBytes(16).toString("hex");
    const filePath = path.join(UPLOAD_DIR, filename);
    const out = fs.createWriteStream(filePath);
    req.uploadTemp = { path: filePath, out };
    // una sola risposta a multer, anche se il file viene chiuso a forza da discardUpload
    let settled = false;
    const finish = (err, info) => {
      if (settled) return;
      settled = true;
      cb(err, info);
    };
    file.stream.pipe(out);
    out.on("error", finish);
    out.on("finish", () => finish(null, { destination: UPLOAD_DIR, filename, path: filePath, size: out.bytesWritten }));
  },
  _removeFile(_req, file, cb) {
    // un file chiuso a forza non ha il percorso: è già stato cancellato da discardUpload
    if (!file.path) return cb(null);
    fs.unlink(file.path, () => cb(null));
  },
};

/** Chiude e cancella il file parziale di una ricezione interrotta. */
export function discardUpload(req) {
  const temp = req.uploadTemp;
  if (!temp) return Promise.resolve();
  req.uploadTemp = null;
  temp.out.destroy();
  return fs.promises.unlink(temp.path).catch(() => {});
}
