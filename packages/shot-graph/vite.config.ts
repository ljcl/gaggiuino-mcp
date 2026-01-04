import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;

export default defineConfig({
  plugins: [react(), ...(INPUT ? [viteSingleFile()] : [])],
  build: INPUT
    ? {
        rollupOptions: { input: INPUT },
        outDir: "../../dist/shot-graph",
        emptyOutDir: false,
      }
    : {},
});
