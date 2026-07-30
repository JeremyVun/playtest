import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Repository convention: Vite must never load `.env` files.
export default defineConfig({
  plugins: [react()],
  envDir: false,
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4190,
  },
  preview: {
    host: '127.0.0.1',
    port: 4190,
  },
});
