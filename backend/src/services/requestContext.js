/**
 * Contesto della richiesta in corso (AsyncLocalStorage): l'utente che l'ha fatta.
 * Permette di attribuire i token consumati e le attività all'utente giusto anche nel codice
 * più "profondo" (embedding, data agent) senza passare l'utente come parametro ovunque.
 * Fuori da una richiesta (es. indicizzazione all'avvio) l'utente è "system".
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export const runWithUser = (user, fn) => storage.run({ userId: user.id, userName: user.name }, fn);

export const currentUserId = () => storage.getStore()?.userId ?? "system";
