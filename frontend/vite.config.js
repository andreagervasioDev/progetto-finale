import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In sviluppo tutte le chiamate /api vengono inoltrate al backend Node (niente problemi di CORS)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_BACKEND_URL || "http://localhost:3002", changeOrigin: true },
    },
  },
});
