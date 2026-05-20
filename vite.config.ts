import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    chunkSizeWarningLimit: 1000
  },
  plugins: [react()]
});
