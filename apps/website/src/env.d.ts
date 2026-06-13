/// <reference types="vite/client" />
import type {} from "@uncorded/electron-bridge";

interface ImportMetaEnv {
  readonly VITE_CENTRAL_URL?: string;
  /** "1" opts the live CoView viewer into the projected arm (dev/dogfood only). */
  readonly VITE_UNCORDED_COVIEW_PROJECTED_VIEWER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
