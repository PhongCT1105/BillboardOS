/// <reference types="vite/client" />
// Module map for convex-test (everything Convex would deploy, plus codegen).
export const modules = import.meta.glob([
  "./**/*.ts",
  "./**/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
  "!./test.setup.ts",
]);
