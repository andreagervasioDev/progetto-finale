export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
}

export function relativeTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "adesso";
  if (diff < 3600) return `${Math.floor(diff / 60)} min fa`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h fa`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} g fa`;
  return formatDate(ts);
}

export const ACCEPTED_EXT = [".pdf", ".docx", ".txt", ".md", ".csv", ".xlsx", ".xls"];
export const MAX_SIZE_MB = 20;
