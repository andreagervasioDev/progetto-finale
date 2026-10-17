/**
 * Log degli errori lato server, in un formato unico.
 *
 * Il dettaglio tecnico (messaggio, codice, traccia) resta nei log del server e non arriva mai al client.
 * Si registrano solo i campi utili invece dell'intero oggetto d'errore: per esempio gli errori dell'SDK
 * OpenAI contengono anche header e corpo della risposta, che non servono a capire il problema.
 */
export function logError(context, err) {
  const status = err?.status ?? err?.statusCode;
  const code = err?.code ?? err?.type;
  const meta = [status && `status ${status}`, code && `codice ${code}`].filter(Boolean).join(", ");
  console.error(`${context} ${err?.message ?? err}${meta ? ` (${meta})` : ""}`);
  if (err?.stack) console.error(err.stack.split("\n").slice(1, 6).join("\n"));
}
