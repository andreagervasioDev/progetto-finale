/** Scadenze estratte dall'AI (contratti, sponsorizzazioni, certificati, offerte). Funzioni pure, senza I/O. */

/** Quanto a lungo una scadenza passata resta visibile nella Home. */
export const EXPIRED_VISIBLE_DAYS = 60;

const DAY_MS = 86400000;

/** Giorni dalla data di oggi (mezzanotte locale) alla data ISO "YYYY-MM-DD"; negativi se già passata. */
export function daysUntil(isoDate, now = new Date()) {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - today) / DAY_MS);
}

/**
 * Documenti con una scadenza, dalla più vicina; quelle passate da più di EXPIRED_VISIBLE_DAYS giorni sono escluse.
 * @returns {Array<{doc: object, daysLeft: number}>}
 */
export function upcomingDeadlines(docs, now = new Date()) {
  return docs
    .filter((d) => d.facts?.expiryDate)
    .map((doc) => ({ doc, daysLeft: daysUntil(doc.facts.expiryDate, now) }))
    .filter((d) => d.daysLeft >= -EXPIRED_VISIBLE_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
