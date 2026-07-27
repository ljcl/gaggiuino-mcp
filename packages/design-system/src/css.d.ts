/**
 * CSS imports are resolved by Vite (Storybook, and the shot-graph bundle).
 * Declared locally rather than pulling in `vite/client` so this package keeps
 * its no-runtime-dependency shape.
 */
declare module "*.css" {
  const url: string;
  export default url;
}

declare module "*.css?raw" {
  const content: string;
  export default content;
}
