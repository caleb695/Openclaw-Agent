import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  base: './',
  server: { host: '0.0.0.0', allowedHosts: ['.e2b.app'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.e2b.app'] },
  build: { outDir: '../dist', emptyOutDir: true },
});
