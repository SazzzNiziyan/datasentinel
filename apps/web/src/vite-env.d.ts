/// <reference types="vite/client" />

// Every VITE_* variable the web app reads. Values are public: they are
// bundled into the browser. Keep in sync with .env.example.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
