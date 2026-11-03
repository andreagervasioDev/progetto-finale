/**
 * Scritture sicure dei file JSON dell'archivio (conversazioni, utenti, documenti, cache delle risposte).
 *
 *   - writeJsonAtomic: scrive in un file temporaneo con nome unico e poi lo rinomina. Un arresto a metà
 *     non corrompe il file, e due scritture contemporanee non si mescolano nello stesso temporaneo.
 *   - withLock: coda di Promise per chiave. Le operazioni "leggi, modifica, riscrivi" sulla stessa
 *     chiave (es. la stessa conversazione) avvengono una alla volta; chiavi diverse restano in parallelo.
 *     Basta una coda in memoria perché il backend è un solo processo Node.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const queues = new Map(); // chiave -> ultima operazione in coda

export function withLock(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  // la coda prosegue anche se un'operazione fallisce; l'errore arriva comunque a chi l'ha chiamata
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key); // coda vuota: niente chiavi accumulate
  });
  return run;
}

export async function writeJsonAtomic(file, data, space) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, space));
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
