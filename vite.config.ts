import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ command }) => ({
  // GitHub Pages serves from /singing-tutor/; Vercel (which sets VERCEL=1)
  // and the dev server serve from the root
  base:
    command === "build" && !process.env.VERCEL ? "/singing-tutor/" : "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Singing Tutor",
        short_name: "SingTutor",
        description:
          "Real-time pitch training, scored exercises, songs, and an AI vocal coach.",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#0b0d12",
        theme_color: "#0b0d12",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
}));
