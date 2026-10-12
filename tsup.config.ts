import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  noExternal: ['zod'],
  platform: 'neutral',
  sourcemap: true,
  target: 'es2022',
});
