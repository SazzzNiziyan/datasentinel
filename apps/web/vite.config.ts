import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // One .env at the repository root serves every app. Vite exposes only
  // VITE_* variables to the browser; never put a secret in one.
  envDir: '../..',
  resolve: {
    // Read workspace packages (contracts) from source in dev and build, so
    // they never need a separate build step for the web app (D-13).
    conditions: ['@datasentinel/source', ...defaultClientConditions],
  },
  server: { port: 5173, strictPort: true },
});
