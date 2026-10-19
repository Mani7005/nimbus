/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Nimbus API, e.g. https://api.example.com. Required for production builds. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
