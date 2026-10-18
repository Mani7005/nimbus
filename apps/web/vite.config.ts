import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveApiBaseUrl } from "./src/config/api-url.ts";

export default defineConfig(({ command, mode }) => {
  // Fails every `vite build`, whatever its --mode, when VITE_API_URL is missing or unsuitable, before anything is
  // bundled: built apps run with import.meta.env.PROD = true, so they apply the production rules at runtime too.
  // The dev server (command "serve") is unaffected and falls back to the local API.
  if (command === "build") {
    const { VITE_API_URL } = loadEnv(mode, process.cwd(), "VITE_");
    resolveApiBaseUrl({ VITE_API_URL, production: true });
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
  };
});
