/// <reference types="vite/client" />
import type {} from "@uncorded/electron-bridge";

interface ImportMetaEnv {
  readonly VITE_CENTRAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
