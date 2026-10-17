import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(__dirname, "..");

// Un unico file .env nella root del progetto, condiviso da backend e data agent
dotenv.config({ path: path.resolve(BACKEND_DIR, "..", ".env"), quiet: true });

// il segnaposto di .env.example non è una chiave valida
const apiKey = process.env.OPENAI_API_KEY;
const isPlaceholder = !apiKey || apiKey.trim() === "sk-...";

export const config = {
  port: Number(process.env.BACKEND_PORT || 3002),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  openaiApiKey: isPlaceholder ? undefined : apiKey.trim(),
  chatModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  chroma: {
    host: process.env.CHROMA_HOST || "localhost",
    port: Number(process.env.CHROMA_PORT || 8000),
    collection: process.env.CHROMA_COLLECTION || "management_ai_documents",
  },
  // documenti ufficiali importati all'avvio (PDF, Word, Markdown, TXT)
  knowledgeBaseDir: path.resolve(BACKEND_DIR, process.env.KNOWLEDGE_BASE_DIR || "knowledge_base"),
  // profilo, documenti e conversazioni salvati su disco
  storageDir: path.resolve(BACKEND_DIR, process.env.STORAGE_DIR || "storage"),
  dataAgentUrl: process.env.DATA_AGENT_URL || "http://127.0.0.1:8001",
  dataAgentTimeoutMs: Number(process.env.DATA_AGENT_TIMEOUT_MS || 180000),
  maxAgentSteps: Number(process.env.MAX_AGENT_STEPS || 6),
  maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES || 20),
  auth: {
    // chiave per firmare le sessioni: se manca viene generata e salvata in storage/.auth_secret
    secret: process.env.AUTH_SECRET || null,
    sessionDays: Number(process.env.SESSION_DAYS || 7),
    // password degli utenti creati al primo avvio (cambiale nel .env prima di condividere l'app)
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || "admin",
    defaultTestPassword: process.env.DEFAULT_TEST_PASSWORD || "test",
  },
};

export function assertOpenAIKey() {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY mancante: copia .env.example in .env nella root del progetto e inserisci la chiave.");
  }
}
