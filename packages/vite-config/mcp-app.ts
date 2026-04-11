import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Shared Vite config for Gaggiuino MCP Apps.
 *
 * When the INPUT environment variable is set, builds the given HTML entry as
 * a single-file bundle suitable for serving as an MCP `ui://` resource.
 * Otherwise acts as a plain React dev config.
 *
 * @param outDir - Build output directory, relative to the consuming package
 */
export function mcpAppConfig(outDir: string): UserConfig {
  const INPUT = process.env.INPUT;
  return defineConfig({
    plugins: [react(), ...(INPUT ? [viteSingleFile()] : [])],
    build: INPUT
      ? {
          rollupOptions: { input: INPUT },
          outDir,
          emptyOutDir: false,
        }
      : {},
  }) as UserConfig;
}
