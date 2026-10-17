/**
 * Dataset analizzabili dal data agent: quello delle partite (incluso nel progetto)
 * più i file CSV / Excel caricati nell'archivio che l'utente può vedere.
 */
import { listDatasets } from "../clients/dataAgentClient.js";
import { isTabular } from "../documents/extract.js";
import { SYSTEM_OWNER, listVisible } from "../repositories/documentRepository.js";

export const BUILTIN_DATASET = "partite";

export async function availableDatasets(user) {
  const known = new Map((await listDatasets()).map((d) => [d.id, d]));
  const docs = (await listVisible(user)).filter((d) => isTabular(d.ext) && known.has(d.id));
  const builtin = known.get(BUILTIN_DATASET);
  return [
    ...(builtin ? [{ ...builtin, docId: null, official: true }] : []),
    ...docs.map((d) => ({ ...known.get(d.id), title: d.title, docId: d.id, official: d.ownerId === SYSTEM_OWNER })),
  ];
}
