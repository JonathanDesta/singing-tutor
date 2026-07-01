import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // GitHub Pages serves from /singing-tutor/; Vercel (which sets VERCEL=1)
  // and the dev server serve from the root
  base:
    command === "build" && !process.env.VERCEL ? "/singing-tutor/" : "/",
  plugins: [react()],
}));
