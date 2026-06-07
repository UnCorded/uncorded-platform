// Avatar primitive — framework-agnostic so plugin iframes (vanilla JS, no
// Solid/React) and the shell (SolidJS) can share a single renderer.
//
// Output: createAvatar() returns a real HTMLElement. avatarHtml() returns the
// equivalent HTML string for places that build markup with `innerHTML +=`.
// All caller-supplied strings (displayName, avatarUrl, title) are HTML-escaped
// in the string variant; the DOM variant uses textContent / setAttribute and
// has no XSS surface.
//
// Color + initial extraction come from `@uncorded/shared`'s `getClientColor`
// and `getNameInitial` so runtime, web client, and plugin SDK paint the same
// hue for the same user id and split graphemes the same way (Intl.Segmenter).
// The wrapper uses the pastel `background` HSL with dark `foreground` text —
// matching the polished avatar look in the shell.
//
// - Hash is identity-only; never seeded with displayName so a user keeps their
//   color when they rename.
// - Only http(s) URLs render as <img> (defense in depth against `javascript:`,
//   `data:`, or path-relative payloads slipping through upstream).

// Import the avatar-color module directly (not via @uncorded/shared's index)
// so the plugin-sdk-frontend tsconfig doesn't have to typecheck shared's
// Node-only logger module. The two files have zero coupling.
import { getClientColor, getNameInitial } from "@uncorded/shared/src/avatar-color";

export type AvatarShape = "circle" | "square" | "rounded";

export interface AvatarOptions {
  /** Stable user identifier — drives the deterministic fallback color. */
  userId: string;
  /** Human-readable name; first grapheme becomes the initial. */
  displayName?: string | null | undefined;
  /** Optional https URL. Non-http(s) values are ignored and fallback renders. */
  avatarUrl?: string | null | undefined;
  /** Pixel size for width and height. Default 32. */
  size?: number | undefined;
  /** Visual style. Default `circle`. */
  shape?: AvatarShape | undefined;
  /** Title attribute (tooltip). Default = displayName ?? userId. */
  title?: string | undefined;
  /** Extra CSS class names appended to the wrapper. */
  className?: string | undefined;
  /** Click handler — set on the wrapper element. DOM variant only. */
  onClick?: ((ev: MouseEvent) => void) | undefined;
}

/**
 * Deterministic background color for a user's avatar disk — the pastel HSL
 * variant, paired with `avatarTextColor` for the initial.
 */
export function avatarColor(userId: string): string {
  return getClientColor(userId).background;
}

/** Deterministic foreground (text) color, legible on `avatarColor(userId)`. */
export function avatarTextColor(userId: string): string {
  return getClientColor(userId).foreground;
}

/**
 * First grapheme of `displayName`, uppercased — handles emoji and multi-byte
 * scripts without slicing a surrogate pair in half. Returns "?" when the input
 * is empty or whitespace-only. Delegates to the shared util.
 */
export function avatarInitial(displayName: string | null | undefined): string {
  return getNameInitial(displayName);
}

/** Returns true only for `http://` and `https://` — defense against `javascript:` etc. */
export function isSafeAvatarUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  return /^https?:\/\//i.test(url);
}

function shapeRadius(shape: AvatarShape): string {
  switch (shape) {
    case "circle":
      return "50%";
    case "rounded":
      return "20%";
    case "square":
      return "0";
  }
}

function htmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ResolvedAvatar {
  size: number;
  shape: AvatarShape;
  title: string;
  background: string;
  foreground: string;
  initial: string;
  href: string | null;
  className: string;
}

function resolve(opts: AvatarOptions): ResolvedAvatar {
  const size = opts.size ?? 32;
  const shape = opts.shape ?? "circle";
  const displayName = typeof opts.displayName === "string" ? opts.displayName : "";
  const title = opts.title ?? (displayName.length > 0 ? displayName : opts.userId);
  const href = isSafeAvatarUrl(opts.avatarUrl) ? (opts.avatarUrl as string) : null;
  const color = getClientColor(opts.userId);
  return {
    size,
    shape,
    title,
    background: color.background,
    foreground: color.foreground,
    initial: getNameInitial(displayName),
    href,
    className: opts.className ?? "",
  };
}

/**
 * Build an avatar `HTMLElement`. The wrapper is a `<div>` so callers can
 * append it to any layout container or attach event listeners. Falls back to
 * the deterministic-color initial circle when avatarUrl is missing or fails
 * to load (handled via the `<img>` `onerror` hook).
 */
export function createAvatar(opts: AvatarOptions): HTMLElement {
  const r = resolve(opts);
  const wrapper = document.createElement("div");
  if (r.className.length > 0) wrapper.className = r.className;
  wrapper.title = r.title;
  // Background is painted only when there's no image. With an image, the
  // wrapper stays transparent so user PFPs with alpha (transparent PNGs)
  // composite against the surrounding surface instead of a random hue.
  Object.assign(wrapper.style, {
    width: `${String(r.size)}px`,
    height: `${String(r.size)}px`,
    borderRadius: shapeRadius(r.shape),
    background: r.href === null ? r.background : "transparent",
    color: r.foreground,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: "0",
    fontWeight: "600",
    fontSize: `${String(Math.max(10, Math.round(r.size * 0.42)))}px`,
    userSelect: "none",
    cursor: opts.onClick ? "pointer" : "default",
  } as Partial<CSSStyleDeclaration>);

  const initialEl = document.createElement("span");
  initialEl.textContent = r.initial;
  // Hidden when an image is loading so the user never sees the colored fallback
  // through a not-yet-painted img. Revealed by the error handler if it 404s.
  if (r.href !== null) initialEl.style.display = "none";
  wrapper.appendChild(initialEl);

  if (r.href !== null) {
    const img = document.createElement("img");
    img.src = r.href;
    img.alt = r.title;
    img.loading = "lazy";
    img.decoding = "async";
    Object.assign(img.style, {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
    } as Partial<CSSStyleDeclaration>);
    img.addEventListener("error", () => {
      img.remove();
      wrapper.style.background = r.background;
      initialEl.style.display = "";
    });
    wrapper.appendChild(img);
  }

  if (opts.onClick) {
    wrapper.addEventListener("click", opts.onClick);
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("tabindex", "0");
  }

  return wrapper;
}

/**
 * HTML-string equivalent of `createAvatar()` for callers that build markup
 * with string concatenation (e.g. `container.innerHTML += avatarHtml(...)`).
 * All inputs are HTML-escaped — safe to interpolate user-controlled values.
 */
export function avatarHtml(opts: AvatarOptions): string {
  const r = resolve(opts);
  const fontSize = Math.max(10, Math.round(r.size * 0.42));
  const sharedStyle = [
    `width:${String(r.size)}px`,
    `height:${String(r.size)}px`,
    `border-radius:${shapeRadius(r.shape)}`,
    `color:${r.foreground}`,
    `display:inline-flex`,
    `align-items:center`,
    `justify-content:center`,
    `overflow:hidden`,
    `flex-shrink:0`,
    `font-weight:600`,
    `font-size:${String(fontSize)}px`,
    `user-select:none`,
  ];
  const titleAttr = htmlEscape(r.title);
  const cls = r.className.length > 0 ? ` class="${htmlEscape(r.className)}"` : "";

  if (r.href === null) {
    // Pure fallback: colored disk + initial. No image means no transparency
    // concern, so we paint the deterministic background here and only here.
    const wrapperStyle = [...sharedStyle, `background:${r.background}`].join(";");
    return `<div${cls} title="${titleAttr}" style="${wrapperStyle}">` +
      `<span>${htmlEscape(r.initial)}</span></div>`;
  }
  // Image path: wrapper background stays transparent so the user's PFP
  // composites against whatever surrounds the avatar (sidebar bg, message
  // row, etc.). The initial span is `display:none` during load and only
  // becomes visible if the image errors out — at which point we also restore
  // the colored disk via inline JS. Inline handlers are safe because the URL
  // already passed isSafeAvatarUrl.
  const wrapperStyle = [...sharedStyle, `background:transparent`].join(";");
  const imgStyle = "width:100%;height:100%;object-fit:cover;display:block";
  const safeUrl = htmlEscape(r.href);
  const safeBg = htmlEscape(r.background);
  return (
    `<div${cls} title="${titleAttr}" style="${wrapperStyle}">` +
    `<span style="display:none">${htmlEscape(r.initial)}</span>` +
    `<img src="${safeUrl}" alt="${titleAttr}" loading="lazy" decoding="async" ` +
    `style="${imgStyle}" ` +
    `onerror="this.parentElement.style.background='${safeBg}';` +
    `this.previousSibling.style.display='';this.remove()">` +
    `</div>`
  );
}
