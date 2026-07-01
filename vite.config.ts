import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // served from https://<user>.github.io/singing-tutor/ in production
  base: command === "build" ? "/singing-tutor/" : "/",
  plugins: [react()],
}));
