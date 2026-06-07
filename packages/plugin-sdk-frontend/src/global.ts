// Global build entry point.
// Built as an IIFE (--format iife) so plugin frontends can load it via a plain
// <script src="/sdk/plugin-frontend.js"> without triggering CORS.
//
// Classic <script src> uses no-cors fetch — no Origin header, no CORS check.
// This is necessary because sandboxed iframes (no allow-same-origin) have an
// opaque null origin, and Access-Control-Allow-Origin: * explicitly does NOT
// match Origin: null per the Fetch spec.
//
// Sets: window.UncodedPlugin = { createPluginFrontend, createAvatar, avatarHtml, ... }

import { createPluginFrontend } from "./plugin";
import {
  avatarColor,
  avatarHtml,
  avatarInitial,
  createAvatar,
  isSafeAvatarUrl,
} from "./avatar";

(globalThis as unknown as Record<string, unknown>).UncodedPlugin = {
  createPluginFrontend,
  createAvatar,
  avatarHtml,
  avatarColor,
  avatarInitial,
  isSafeAvatarUrl,
};
