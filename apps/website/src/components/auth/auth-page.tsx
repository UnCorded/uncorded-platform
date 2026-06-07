import { createSignal, Show, Switch, Match, onMount, onCleanup, type Accessor } from "solid-js";
import {
  Bookmark,
  Check,
  ChevronsUpDown,
  Hash,
  Home,
  Inbox,
  Lock,
  MessageSquare,
  Server,
  Smartphone,
  Users,
  Volume2,
  Zap,
} from "lucide-solid";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { login, loginWithOAuth, authError, sessionExpiredReason, authNotice } from "@/stores/auth";
import * as central from "@/api/central";
import { ApiError } from "@/api/types";
import { GoogleIcon, DiscordIcon, GitHubIcon } from "@/components/auth/oauth-icons";

// Turnstile only runs in real browser contexts — not under Electron's file://
const TURNSTILE_SITE_KEY =
  typeof window !== "undefined" && window.location.protocol !== "file:"
    ? (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)
    : undefined;

declare global {
  interface Window {
    turnstile?: {
      render(
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
        },
      ): string;
      reset(widgetId: string): void;
      remove(widgetId: string): void;
    };
  }
}

export function AuthPage() {
  const [mode, setMode] = createSignal<"login" | "register">("login");

  return (
    <div class="grid min-h-svh lg:grid-cols-2">
      {/* ── Left: form side ─────────────────────────────────────────────── */}
      <div class="flex flex-col gap-4 p-6 md:p-10">
        {/* Logo */}
        <div class="flex justify-center gap-2 md:justify-start">
          <div class="flex items-center gap-3 font-semibold text-xl">
            <div class="flex size-12 items-center justify-center rounded-xl overflow-hidden shrink-0">
              <img src="/uncorded-icon.png" alt="UnCorded" class="size-full object-contain" />
            </div>
            UnCorded
          </div>
        </div>

        {/* Form */}
        <div class="flex flex-1 items-center justify-center">
          <div class="w-full max-w-sm space-y-5">
            {/* Session-expired banner — shown when the user was kicked back
                to auth by a mid-session 401. Cleared by a successful login. */}
            <Show when={sessionExpiredReason()}>
              <div
                role="status"
                class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
              >
                {sessionExpiredReason()}
              </div>
            </Show>

            {/* Auth notice banner — covers signed-out arrivals from external
                flows (e.g. expired email verification link bouncing back to
                /?error=verify_failed). Severity drives the color. */}
            <Show when={authNotice()}>
              {(notice) => (
                <div
                  role="status"
                  class={cn(
                    "rounded-md border px-3 py-2 text-sm",
                    notice().severity === "error"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
                  )}
                >
                  {notice().message}
                </div>
              )}
            </Show>

            {/* Tab switcher */}
            <div class="flex rounded-lg bg-muted p-1 gap-1">
              <TabButton
                label="Sign in"
                active={mode() === "login"}
                onClick={() => setMode("login")}
              />
              <TabButton
                label="Create account"
                active={mode() === "register"}
                onClick={() => setMode("register")}
              />
            </div>

            {/* Active form */}
            <Show
              when={mode() === "login"}
              fallback={<RegisterForm onSwitch={() => setMode("login")} />}
            >
              <LoginForm />
            </Show>
          </div>
        </div>
      </div>

      {/* ── Right: animated UI showcase ─────────────────────────────────── */}
      <div class="relative hidden lg:flex lg:items-center lg:justify-center overflow-hidden bg-sidebar">
        <AppShowcase />
      </div>
    </div>
  );
}

// ── Tab button ─────────────────────────────────────────────────────────────────

function TabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      class={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-150 cursor-pointer",
        props.active
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

// ── Login form ─────────────────────────────────────────────────────────────────

function LoginForm() {
  const [identifier, setIdentifier] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (submitting()) return;
    setSubmitting(true);
    try {
      await login(identifier().trim(), password());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} class="flex flex-col gap-4">
      <div class="flex flex-col gap-1 text-center">
        <h1 class="text-2xl font-bold">Login to your account</h1>
        <p class="text-sm text-muted-foreground text-balance">
          Enter your email or username to log in
        </p>
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="login-identifier" class="text-sm font-medium">
          Email or username
        </label>
        <Input
          id="login-identifier"
          type="text"
          // `username` lets a saved username autofill cleanly; browsers also
          // accept email values for this hint, so a single input covers both.
          autocomplete="username"
          placeholder="m@example.com or yourname"
          required
          value={identifier()}
          onInput={(e) => setIdentifier(e.currentTarget.value)}
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="login-password" class="text-sm font-medium">
          Password
        </label>
        {/* "Forgot your password?" link intentionally absent: there is no
            password-reset flow yet. A dead link is worse than a missing one —
            reintroduce once the reset endpoint ships. */}
        <Input
          id="login-password"
          type="password"
          autocomplete="current-password"
          required
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </div>

      <Show when={authError()}>
        <p class="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
          {authError()}
        </p>
      </Show>

      <Button type="submit" class="w-full" disabled={submitting()}>
        {submitting() ? "Signing in…" : "Sign in"}
      </Button>

      <OAuthDivider />

      <OAuthButtons />
      {/* "Don't have an account?" prompt omitted — the Create-account tab
          at the top of the card already provides the affordance, and a
          trailing line with no link read as broken. */}
    </form>
  );
}

// ── Register form ──────────────────────────────────────────────────────────────

// Mirror of apps/central/src/usernames.ts charset/length rules. Kept inline
// (not imported from Central) because the website doesn't depend on the
// Central source — the rules are part of the public auth surface and rarely
// change. Server-side validation is still authoritative; this is just for
// inline UI hints.
const USERNAME_RE = /^[a-z0-9_]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;

function validateUsernameClient(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return "Username is required.";
  if (trimmed.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters.`;
  if (trimmed.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(trimmed)) return "Use lowercase letters, numbers, and underscores only.";
  return null;
}

function RegisterForm(props: { onSwitch: () => void }) {
  const [displayName, setDisplayName] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [captchaToken, setCaptchaToken] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);

  const usernameHint = (): string | null => {
    if (username().length === 0) return null;
    return validateUsernameClient(username());
  };

  let turnstileRef!: HTMLDivElement;
  let widgetId: string | null = null;

  onMount(() => {
    if (!TURNSTILE_SITE_KEY) return;

    function renderWidget() {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render(turnstileRef, {
        sitekey: TURNSTILE_SITE_KEY!,
        callback: (token) => setCaptchaToken(token),
        "expired-callback": () => setCaptchaToken(""),
      });
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.defer = true;
      script.onload = renderWidget;
      document.head.appendChild(script);
    }
  });

  onCleanup(() => {
    if (widgetId !== null) window.turnstile?.remove(widgetId);
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (submitting()) return;
    const usernameErr = validateUsernameClient(username());
    if (usernameErr) {
      setError(usernameErr);
      return;
    }
    if (TURNSTILE_SITE_KEY && !captchaToken()) {
      setError("Please complete the CAPTCHA.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await central.register(
        email(),
        username().trim().toLowerCase(),
        password(),
        displayName(),
        captchaToken(),
      );
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Registration failed. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Show
      when={!done()}
      fallback={
        <div class="flex flex-col items-center gap-4 text-center py-4">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="text-foreground"
            >
              <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              <path d="m16 19 2 2 4-4" />
            </svg>
          </div>
          <div class="space-y-1">
            <p class="font-semibold">Check your inbox</p>
            <p class="text-sm text-muted-foreground text-balance">
              We sent a verification link to{" "}
              <strong class="text-foreground">{email()}</strong>. Click it to activate your
              account.
            </p>
          </div>
          <button
            type="button"
            class="text-sm text-muted-foreground underline-offset-4 hover:underline cursor-pointer"
            onClick={props.onSwitch}
          >
            ← Back to sign in
          </button>
        </div>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} class="flex flex-col gap-4">
        <div class="flex flex-col gap-1 text-center">
          <h1 class="text-2xl font-bold">Create an account</h1>
          <p class="text-sm text-muted-foreground text-balance">
            Join UnCorded — your community, your hardware.
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="reg-name" class="text-sm font-medium">
            Display name
          </label>
          <Input
            id="reg-name"
            type="text"
            autocomplete="name"
            placeholder="Your name"
            required
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
          />
          <p class="text-xs text-muted-foreground">
            Shown next to your messages. Change anytime.
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="reg-username" class="text-sm font-medium">
            Username
          </label>
          <Input
            id="reg-username"
            type="text"
            autocomplete="username"
            placeholder="yourname"
            required
            minLength={USERNAME_MIN}
            maxLength={USERNAME_MAX}
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value.toLowerCase())}
          />
          <Show
            when={usernameHint()}
            fallback={
              <p class="text-xs text-muted-foreground">
                3–20 lowercase letters, numbers, or underscores. One change per 30 days after signup.
              </p>
            }
          >
            <p class="text-xs text-destructive">{usernameHint()}</p>
          </Show>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="reg-email" class="text-sm font-medium">
            Email
          </label>
          <Input
            id="reg-email"
            type="email"
            autocomplete="email"
            placeholder="m@example.com"
            required
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="reg-password" class="text-sm font-medium">
            Password
          </label>
          <Input
            id="reg-password"
            type="password"
            autocomplete="new-password"
            placeholder="Minimum 8 characters"
            required
            minLength={8}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>

        <Show when={TURNSTILE_SITE_KEY}>
          <div class="flex justify-center">
            <div ref={turnstileRef} />
          </div>
        </Show>

        <Show when={error()}>
          <p class="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
            {error()}
          </p>
        </Show>

        <Button type="submit" class="w-full" disabled={submitting()}>
          {submitting() ? "Creating account…" : "Create account"}
        </Button>

        <OAuthDivider />

        <OAuthButtons />

        <p class="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <button
            type="button"
            class="text-foreground underline-offset-4 hover:underline cursor-pointer"
            onClick={props.onSwitch}
          >
            Sign in
          </button>
        </p>
      </form>
    </Show>
  );
}

// ── OAuth divider ──────────────────────────────────────────────────────────────

function OAuthDivider() {
  return (
    <div class="relative">
      <div class="absolute inset-0 flex items-center">
        <span class="w-full border-t border-border" />
      </div>
      <div class="relative flex justify-center text-xs">
        <span class="bg-background px-2 text-muted-foreground">Or continue with</span>
      </div>
    </div>
  );
}

// Three icon-only buttons in a row keeps the form short as we add providers.
// `aria-label` carries the provider name for screen readers.
function OAuthButtons() {
  const [submitting, setSubmitting] = createSignal<"google" | "discord" | "github" | null>(null);

  async function start(provider: "google" | "discord" | "github"): Promise<void> {
    if (submitting()) return;
    setSubmitting(provider);
    try {
      await loginWithOAuth(provider);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div class="grid grid-cols-3 gap-2">
      <button
        type="button"
        onClick={() => void start("google")}
        disabled={submitting() !== null}
        aria-label="Continue with Google"
        class={cn(buttonVariants({ variant: "outline" }), "w-full")}
      >
        <GoogleIcon />
      </button>
      <button
        type="button"
        onClick={() => void start("discord")}
        disabled={submitting() !== null}
        aria-label="Continue with Discord"
        class={cn(buttonVariants({ variant: "outline" }), "w-full")}
      >
        <DiscordIcon />
      </button>
      <button
        type="button"
        onClick={() => void start("github")}
        disabled={submitting() !== null}
        aria-label="Continue with GitHub"
        class={cn(buttonVariants({ variant: "outline" }), "w-full")}
      >
        <GitHubIcon />
      </button>
    </div>
  );
}

// ── Right panel: animated app showcase ────────────────────────────────────────

type ShowcaseSyncState = "local" | "saving" | "saved" | "dirty";

/**
 * Auto-playing showcase: a virtual user pilots the actual UnCorded UI inside
 * a fake browser window. Cursor is JS-tweened with cubic easing (not linear
 * CSS keyframes) so motion reads as human; every state — server selection,
 * channel drag, drop-zone preview, bookmark sync state, browser resize,
 * dirty/re-save, phone sync — uses the same components and treatments the
 * shipped app does.
 *
 * Loop (~22s):
 *   0.0s  enter, hover Gaming Hub server in no-server sidebar
 *   1.7s  click → sidebar fades to with-server (channel list)
 *   2.5s  approach #general
 *   3.0s  press + drag → ghost follows; right drop-zone highlights
 *   5.6s  drop → main panel splits (#general | voice)
 *   6.5s  approach bookmark on workspace tab
 *   7.4s  click → saving spinner → solid white (saved)
 *   9.0s  phone slides in from right edge of window
 *  11.0s  cursor moves to right-edge resize handle
 *  11.8s  drag inward → window narrows, voice panel collapses
 *  13.0s  bookmark goes dirty (animate-pulse)
 *  14.1s  re-click bookmark → saving → solid white again
 *  15.5s  hold steady on synced state, fade for loop reset
 */
function AppShowcase() {
  // ── Animation state ────────────────────────────────────────────────────
  const [cursorPos, setCursorPos] = createSignal({ x: -32, y: 240 });
  const [cursorPressed, setCursorPressed] = createSignal(false);
  const [serverHover, setServerHover] = createSignal(false);
  const [serverSelected, setServerSelected] = createSignal(false);
  const [channelHover, setChannelHover] = createSignal(false);
  const [channelGrabbed, setChannelGrabbed] = createSignal(false);
  const [dropZoneActive, setDropZoneActive] = createSignal(false);
  const [layoutSplit, setLayoutSplit] = createSignal(false);
  const [bookmarkHover, setBookmarkHover] = createSignal(false);
  const [syncState, setSyncState] = createSignal<ShowcaseSyncState>("local");
  const [phoneVisible, setPhoneVisible] = createSignal(false);
  const [windowWidth, setWindowWidth] = createSignal(380);
  const [resizeHover, setResizeHover] = createSignal(false);
  const [resizeGrabbed, setResizeGrabbed] = createSignal(false);

  // ── Animation runtime ──────────────────────────────────────────────────
  // AbortController is the master "stop everything" so awaited tweens and
  // waits resolve immediately on unmount instead of leaking promises.
  const ac = new AbortController();
  let raf = 0;

  // Smoothstep — symmetric ease-in/out, the usual "natural cursor" feel.
  const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
  // Cubic ease-out — for the initial cursor entry, decelerating into target.
  const easeOut = (t: number): number => 1 - (1 - t) ** 3;

  function wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ac.signal.aborted) {
        resolve();
        return;
      }
      const id = window.setTimeout(resolve, ms);
      ac.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    });
  }

  function tween(
    apply: (eased: number) => void,
    durationMs: number,
    ease: (t: number) => number = easeInOut,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ac.signal.aborted) {
        resolve();
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        if (ac.signal.aborted) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - start) / durationMs);
        apply(ease(t));
        if (t < 1) raf = requestAnimationFrame(tick);
        else resolve();
      };
      raf = requestAnimationFrame(tick);
    });
  }

  function moveCursor(
    toX: number,
    toY: number,
    durationMs: number,
    ease: (t: number) => number = easeInOut,
  ): Promise<void> {
    const fromX = cursorPos().x;
    const fromY = cursorPos().y;
    return tween(
      (e) => setCursorPos({ x: fromX + (toX - fromX) * e, y: fromY + (toY - fromY) * e }),
      durationMs,
      ease,
    );
  }

  function tweenWindowWidth(toWidth: number, durationMs: number): Promise<void> {
    const fromWidth = windowWidth();
    const startY = cursorPos().y;
    return tween(
      (e) => {
        const w = fromWidth + (toWidth - fromWidth) * e;
        setWindowWidth(w);
        // Cursor stays pinned to the right-edge resize handle as it travels.
        setCursorPos({ x: w - 6, y: startY });
      },
      durationMs,
      easeInOut,
    );
  }

  // ── Scene loop ─────────────────────────────────────────────────────────
  async function runLoop(): Promise<void> {
    while (!ac.signal.aborted) {
      // Reset to start state.
      setCursorPos({ x: -32, y: 240 });
      setCursorPressed(false);
      setServerHover(false);
      setServerSelected(false);
      setChannelHover(false);
      setChannelGrabbed(false);
      setDropZoneActive(false);
      setLayoutSplit(false);
      setBookmarkHover(false);
      setSyncState("local");
      setPhoneVisible(false);
      setWindowWidth(380);
      setResizeHover(false);
      setResizeGrabbed(false);
      await wait(500);
      if (ac.signal.aborted) break;

      // 1. Cursor enters from below-left, decelerates onto Gaming Hub row.
      await moveCursor(50, 80, 1100, easeOut);
      setServerHover(true);
      await wait(420);
      // Click.
      setCursorPressed(true);
      await wait(140);
      setCursorPressed(false);
      setServerHover(false);
      setServerSelected(true);
      await wait(550);

      // 2. Move down to #general (now visible in with-server sidebar).
      await moveCursor(56, 134, 720);
      setChannelHover(true);
      await wait(280);

      // 3. Press + drag toward main panel.
      setCursorPressed(true);
      setChannelGrabbed(true);
      await wait(160);
      setChannelHover(false);
      // Drag arc into right half of main panel — hint of overshoot makes it
      // read as a real wrist motion rather than a straight line.
      await moveCursor(210, 175, 900);
      setDropZoneActive(true);
      await moveCursor(290, 165, 700);
      // Dwell to confirm drop.
      await wait(420);

      // 4. Drop.
      setCursorPressed(false);
      setChannelGrabbed(false);
      setDropZoneActive(false);
      setLayoutSplit(true);
      await wait(950);

      // 5. Move up to bookmark on the workspace tab.
      await moveCursor(86, 18, 900);
      setBookmarkHover(true);
      await wait(380);

      // 6. Click → saving → saved.
      setCursorPressed(true);
      await wait(140);
      setCursorPressed(false);
      setSyncState("saving");
      await wait(900);
      setSyncState("saved");
      setBookmarkHover(false);
      await wait(700);

      // 7. Phone slides in.
      setPhoneVisible(true);
      await wait(2000);

      // 8. Move cursor to right edge → drag inward (window resize).
      await moveCursor(374, 150, 950);
      setResizeHover(true);
      await wait(280);
      setCursorPressed(true);
      setResizeGrabbed(true);
      await wait(160);
      await tweenWindowWidth(280, 900);
      setCursorPressed(false);
      setResizeGrabbed(false);
      setResizeHover(false);
      // Resize made the saved layout dirty.
      setSyncState("dirty");
      await wait(1300);

      // 9. Move back to bookmark (now positioned at the narrower window's
      // tab) and re-save.
      await moveCursor(86, 18, 800);
      setBookmarkHover(true);
      await wait(280);
      setCursorPressed(true);
      await wait(140);
      setCursorPressed(false);
      setSyncState("saving");
      await wait(900);
      setSyncState("saved");
      setBookmarkHover(false);
      // Phone preview reflects the new (narrower) layout via syncState.
      await wait(1700);

      // 10. Brief hold then loop reset.
      await wait(700);
    }
  }

  onMount(() => {
    void runLoop();
  });
  onCleanup(() => {
    ac.abort();
    if (raf !== 0) cancelAnimationFrame(raf);
  });
  const messages = [
    {
      name: "Alex",
      initial: "A",
      color: "oklch(0.55 0.18 150)",
      text: "voice plugin v0.5 just shipped",
      time: "2:31",
    },
    {
      name: "Sam",
      initial: "S",
      color: "oklch(0.55 0.20 30)",
      text: "running buttery on the homelab",
      time: "2:33",
    },
    {
      name: "Jordan",
      initial: "J",
      color: "var(--sidebar-primary)",
      text: "moderation update is so clean",
      time: "2:34",
    },
  ];

  const pills = [
    { Icon: Lock, label: "Self-hosted" },
    { Icon: Zap, label: "Plugin-powered" },
    { Icon: Server, label: "Your hardware" },
  ];

  // Body height stays fixed; only width changes during the resize phase.
  const bodyHeight = 280;
  // When the window narrows past this, the secondary (voice) pane collapses —
  // mirrors the responsive fold the real layout would make.
  const compact = (): boolean => windowWidth() < 320;

  return (
    <div class="relative w-full h-full flex flex-col items-center justify-center gap-6 select-none px-6">
      {/* Ambient glow */}
      <div
        class="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 65% 55% at 65% 25%, color-mix(in oklch, var(--sidebar-primary) 25%, transparent), transparent)",
        }}
      />

      {/* Dot grid */}
      <div
        class="absolute inset-0 pointer-events-none opacity-[0.035]"
        style={{
          "background-image":
            "radial-gradient(circle, var(--sidebar-foreground) 1px, transparent 1px)",
          "background-size": "24px 24px",
        }}
      />

      {/* Tagline */}
      <div class="relative text-center space-y-1 z-10">
        <p class="text-lg font-semibold text-sidebar-foreground">
          Your community.{" "}
          <span class="font-bold" style={{ color: "var(--sidebar-primary)" }}>
            Your hardware.
          </span>
        </p>
        <p class="text-sm text-sidebar-foreground/50">
          Self-hosted collaborative platforms, powered by plugins.
        </p>
      </div>

      {/* ── Showcase stage: browser window + phone ─────────────────────── */}
      <div class="relative z-10 flex items-center justify-center" style={{ gap: "20px" }}>
        {/* Browser window */}
        <div
          class="relative rounded-xl border border-border/60 shrink-0"
          style={{
            width: `${windowWidth()}px`,
            animation: "auth-float 7s ease-in-out infinite",
            "box-shadow":
              "0 24px 64px oklch(0 0 0 / 0.6), 0 0 0 1px color-mix(in oklch, var(--sidebar-primary) 25%, transparent)",
          }}
        >
          {/* Browser chrome (traffic-lights + URL bar) */}
          <div class="flex items-center gap-2 px-3 py-2 bg-card border-b border-border/60 rounded-t-xl">
            <div class="flex items-center gap-1.5 shrink-0">
              <div class="size-2.5 rounded-full bg-destructive/70" />
              <div class="size-2.5 rounded-full bg-amber-500/70" />
              <div class="size-2.5 rounded-full bg-emerald-500/70" />
            </div>
            <div class="ml-1 flex-1 flex items-center gap-1.5 rounded-md bg-muted/40 border border-border/40 px-2 py-0.5 min-w-0">
              <Lock class="size-2.5 shrink-0 text-emerald-500/80" />
              <span class="text-[10px] text-muted-foreground/80 truncate">uncorded.app</span>
            </div>
          </div>

          {/* App body — scene happens inside this rectangle */}
          <div
            class="relative flex overflow-hidden rounded-b-xl"
            style={{ height: `${bodyHeight}px` }}
          >
            {/* ── Sidebar ──────────────────────────────────────────── */}
            <div class="relative flex w-36 shrink-0 flex-col bg-sidebar border-r border-border/60">
              {/* Brand header */}
              <div class="flex items-center gap-2 px-2 py-2 z-10">
                <div class="flex size-6 items-center justify-center rounded-md overflow-hidden shrink-0">
                  <img src="/uncorded-icon.png" alt="" class="size-full object-contain" />
                </div>
                <span class="font-bold text-[11px] text-sidebar-foreground">UnCorded</span>
              </div>

              {/* No-server overlay */}
              <div
                class="absolute inset-0 pt-9 pb-9 px-1.5 flex flex-col gap-px transition-opacity duration-500 ease-out pointer-events-none"
                style={{ opacity: serverSelected() ? 0 : 1 }}
              >
                <p class="px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                  Your servers
                </p>
                <div
                  class="flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-150"
                  style={{
                    background: serverHover()
                      ? "color-mix(in oklch, var(--sidebar-primary) 18%, transparent)"
                      : "transparent",
                  }}
                >
                  <div
                    class="flex size-5 items-center justify-center rounded-sm text-[8px] font-bold text-white shrink-0"
                    style={{ background: "var(--sidebar-primary)" }}
                  >
                    G
                  </div>
                  <span class="text-[10px] truncate text-sidebar-foreground/85">Gaming Hub</span>
                  <div class="ml-auto size-1.5 rounded-full bg-emerald-500" />
                </div>
                <div class="flex items-center gap-1.5 rounded-md px-1.5 py-1">
                  <div
                    class="flex size-5 items-center justify-center rounded-sm text-[8px] font-bold text-white shrink-0"
                    style={{ background: "oklch(0.55 0.18 150)" }}
                  >
                    D
                  </div>
                  <span class="text-[10px] truncate text-sidebar-foreground/55">Dev Cave</span>
                  <div class="ml-auto size-1.5 rounded-full bg-muted-foreground/40" />
                </div>
                <div class="flex items-center gap-1.5 rounded-md px-1.5 py-1">
                  <div
                    class="flex size-5 items-center justify-center rounded-sm text-[8px] font-bold text-white shrink-0"
                    style={{ background: "oklch(0.55 0.20 30)" }}
                  >
                    H
                  </div>
                  <span class="text-[10px] truncate text-sidebar-foreground/55">Homelab</span>
                  <div class="ml-auto size-1.5 rounded-full bg-emerald-500" />
                </div>
              </div>

              {/* With-server overlay */}
              <div
                class="absolute inset-0 top-9 flex flex-col transition-opacity duration-500 ease-out"
                style={{ opacity: serverSelected() ? 1 : 0 }}
              >
                <div class="mx-1.5 mb-2 flex items-center gap-1.5 rounded-md bg-sidebar-accent px-1.5 py-1.5">
                  <div class="relative shrink-0">
                    <div
                      class="flex size-6 items-center justify-center rounded-md text-[9px] font-bold text-white"
                      style={{ background: "var(--sidebar-primary)" }}
                    >
                      G
                    </div>
                    <span
                      class="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500"
                      style={{ "box-shadow": "0 0 0 1.5px var(--sidebar-accent)" }}
                    />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[10px] font-semibold truncate text-sidebar-accent-foreground">
                      Gaming Hub
                    </div>
                    <div class="text-[8px] text-muted-foreground truncate">24 online</div>
                  </div>
                  <ChevronsUpDown class="size-3 shrink-0 text-muted-foreground" />
                </div>

                <div class="flex-1 overflow-hidden px-1.5 flex flex-col gap-2">
                  <div class="space-y-px">
                    <p class="px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                      Text
                    </p>
                    {/* #general — hover + grabbed states drive its appearance */}
                    <div
                      class="flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-all duration-150"
                      style={{
                        background: channelHover()
                          ? "var(--sidebar-accent)"
                          : "transparent",
                        color: channelHover()
                          ? "var(--sidebar-accent-foreground)"
                          : "var(--sidebar-foreground)",
                        opacity: channelGrabbed() ? 0.35 : 1,
                      }}
                    >
                      <span class="text-[10px] text-muted-foreground/55">#</span>
                      <span class="text-[10px] truncate">general</span>
                    </div>
                    {["announcements", "dev-talk", "random"].map((name) => (
                      <div class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sidebar-foreground/55">
                        <span class="text-[10px] text-muted-foreground/55">#</span>
                        <span class="text-[10px] truncate">{name}</span>
                      </div>
                    ))}
                  </div>

                  <div class="space-y-px">
                    <p class="px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                      Voice
                    </p>
                    <div class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sidebar-foreground/55">
                      <Volume2 class="size-2.5 text-muted-foreground/55" />
                      <span class="text-[10px] truncate">General Voice</span>
                      <span class="ml-auto text-[8px] text-muted-foreground">3</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* User footer */}
              <div class="mt-auto border-t border-border/60 px-1.5 py-1.5 flex items-center gap-1.5 z-10 bg-sidebar">
                <div class="size-5 shrink-0 rounded-md bg-muted flex items-center justify-center text-[8px] font-bold text-muted-foreground">
                  U
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-[9px] font-semibold truncate text-sidebar-foreground">You</div>
                </div>
              </div>
            </div>

            {/* ── Main panel ───────────────────────────────────────── */}
            <div class="relative flex flex-1 flex-col bg-background overflow-hidden min-w-0">
              {/* Workspace tab bar — fades in once a server is selected */}
              <div
                class="flex items-center gap-1 border-b border-border/60 px-2 bg-muted/30 transition-opacity duration-400 ease-out shrink-0"
                style={{
                  opacity: serverSelected() ? 1 : 0,
                  height: "26px",
                }}
              >
                <div
                  class="flex items-center gap-1.5 rounded-md bg-background border px-2 py-0.5 transition-colors duration-150"
                  style={{
                    "border-color": bookmarkHover()
                      ? "color-mix(in oklch, var(--sidebar-primary) 50%, transparent)"
                      : "color-mix(in oklch, var(--border) 100%, transparent)",
                  }}
                >
                  <BookmarkIndicator state={syncState} hover={bookmarkHover} />
                  <span class="text-[9px] font-medium text-foreground">Daily channels</span>
                </div>
                <div class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground/60">
                  <span class="text-[9px]">+</span>
                </div>
              </div>

              {/* Empty hint — visible until a panel is dropped */}
              <div
                class="absolute inset-0 top-[26px] flex flex-col items-center justify-center gap-1.5 text-muted-foreground/40 transition-opacity duration-300 ease-out pointer-events-none"
                style={{
                  opacity:
                    serverSelected() && !layoutSplit() && !channelGrabbed() ? 1 : 0,
                }}
              >
                <MessageSquare class="size-5" />
                <p class="text-[10px]">Drag a channel here to begin</p>
              </div>

              {/* Drop-zone preview — primary-tinted right half during the drag */}
              <Show when={dropZoneActive()}>
                <div
                  class="absolute right-0 bottom-0 border-l-2 border-sidebar-primary pointer-events-none z-10"
                  style={{
                    top: "26px",
                    width: "50%",
                    background:
                      "color-mix(in oklch, var(--sidebar-primary) 14%, transparent)",
                    "box-shadow":
                      "inset 0 0 0 1px color-mix(in oklch, var(--sidebar-primary) 30%, transparent)",
                  }}
                />
              </Show>

              {/* Saved layout — split (channel | voice) or stacked when narrow */}
              <div
                class="absolute left-0 right-0 bottom-0 flex transition-opacity duration-400 ease-out"
                style={{
                  top: "26px",
                  opacity: layoutSplit() ? 1 : 0,
                  "pointer-events": layoutSplit() ? "auto" : "none",
                }}
              >
                {/* Channel pane */}
                <div
                  class="relative flex flex-col min-w-0"
                  style={{
                    flex: "1 1 0",
                    "border-right": compact() ? "none" : "1px solid var(--border)",
                  }}
                >
                  <div class="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 shrink-0">
                    <Hash class="size-3 text-muted-foreground/60" />
                    <span class="text-[10px] font-semibold text-foreground">general</span>
                    <span class="ml-auto flex items-center gap-1 text-[9px] text-muted-foreground">
                      <Users class="size-2.5" />
                      24
                    </span>
                  </div>
                  <div class="flex-1 flex flex-col gap-2 overflow-hidden p-2">
                    {messages.map((m) => (
                      <div class="flex items-start gap-1.5">
                        <div
                          class="size-4 shrink-0 rounded-full flex items-center justify-center text-[7px] font-bold text-white"
                          style={{ background: m.color }}
                        >
                          {m.initial}
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-baseline gap-1">
                            <span class="text-[9px] font-semibold text-foreground">
                              {m.name}
                            </span>
                            <span class="text-[7px] text-muted-foreground/60">{m.time}</span>
                          </div>
                          <p class="text-[9px] leading-snug text-muted-foreground truncate">
                            {m.text}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div class="px-2 pb-2 shrink-0">
                    <div class="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-[9px] text-muted-foreground/40 truncate">
                      Message #general
                    </div>
                  </div>
                </div>

                {/* Voice pane — collapses on narrow */}
                <Show when={!compact()}>
                  <div class="flex flex-col" style={{ width: "120px" }}>
                    <div class="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5 shrink-0">
                      <Volume2 class="size-3 text-muted-foreground/60" />
                      <span class="text-[10px] font-semibold text-foreground truncate">
                        Voice
                      </span>
                    </div>
                    <div class="flex-1 flex flex-col gap-1.5 p-2 overflow-hidden">
                      {[
                        { initial: "A", color: "oklch(0.55 0.18 150)", name: "Alex" },
                        { initial: "S", color: "oklch(0.55 0.20 30)", name: "Sam" },
                        { initial: "J", color: "var(--sidebar-primary)", name: "Jordan" },
                      ].map((p) => (
                        <div class="flex items-center gap-1.5">
                          <div
                            class="relative size-4 shrink-0 rounded-full flex items-center justify-center text-[7px] font-bold text-white"
                            style={{ background: p.color }}
                          >
                            {p.initial}
                            <span class="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
                          </div>
                          <span class="text-[9px] truncate text-muted-foreground">
                            {p.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Show>
              </div>

              {/* Drag ghost — follows the cursor while #general is grabbed */}
              <Show when={channelGrabbed()}>
                <div
                  class="absolute pointer-events-none z-30 flex items-center gap-1.5 rounded-md bg-card border border-sidebar-primary/40 px-1.5 py-1 shadow-lg"
                  style={{
                    left: `${cursorPos().x + 10}px`,
                    top: `${cursorPos().y + 10}px`,
                    "box-shadow":
                      "0 6px 18px oklch(0 0 0 / 0.5), 0 0 0 1px color-mix(in oklch, var(--sidebar-primary) 30%, transparent)",
                  }}
                >
                  <span class="text-[10px] text-muted-foreground/60">#</span>
                  <span class="text-[10px] text-foreground">general</span>
                </div>
              </Show>

              {/* Cursor — JS-tweened position with a press-scale on click */}
              <div
                class="absolute pointer-events-none z-40"
                style={{
                  left: `${cursorPos().x}px`,
                  top: `${cursorPos().y}px`,
                  transform: `translate(-2px, -2px) scale(${cursorPressed() ? 0.86 : 1})`,
                  "transform-origin": "4px 4px",
                  transition: "transform 90ms ease-out",
                  "filter": "drop-shadow(0 1px 2px oklch(0 0 0 / 0.5))",
                }}
              >
                <CursorIcon />
              </div>
            </div>

            {/* Resize handle — hairline on the right edge, lights up on hover */}
            <div
              class="absolute top-0 bottom-0 right-0 z-20 transition-colors duration-150"
              style={{
                width: "4px",
                background: resizeGrabbed()
                  ? "var(--sidebar-primary)"
                  : resizeHover()
                    ? "color-mix(in oklch, var(--sidebar-primary) 40%, transparent)"
                    : "transparent",
              }}
            />
          </div>
        </div>

        {/* Phone — slides in from the right edge of the desktop window */}
        <div
          style={{
            transform: phoneVisible() ? "translateX(0)" : "translateX(60px)",
            opacity: phoneVisible() ? 1 : 0,
            transition: "transform 700ms cubic-bezier(0.22, 1, 0.36, 1), opacity 500ms ease-out",
          }}
        >
          <PhonePreview compact={compact()} synced={syncState() === "saved"} />
        </div>
      </div>

      {/* Feature pills */}
      <div class="relative z-10 flex gap-2 flex-wrap justify-center">
        {pills.map((f, i) => (
          <div
            class="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm"
            style={{ animation: `auth-badge-in 0.5s ease-out ${i * 0.12}s both` }}
          >
            <f.Icon class="size-3" />
            {f.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Showcase helpers ─────────────────────────────────────────────────────────

/**
 * Bookmark sync indicator. Mirrors the BookmarkIcon from workspace-tabs.tsx
 * exactly (saving spinner / saved fill / dirty animate-pulse / local 40%
 * opacity), sized for the showcase tab bar (size-3 instead of size-4).
 */
function BookmarkIndicator(props: {
  state: Accessor<ShowcaseSyncState>;
  hover: Accessor<boolean>;
}) {
  return (
    <Switch>
      <Match when={props.state() === "saving"}>
        <div class="size-3 shrink-0 animate-spin rounded-full border border-sidebar-primary border-t-transparent" />
      </Match>
      <Match when={props.state() === "saved"}>
        <Bookmark class="size-3 shrink-0 fill-sidebar-primary stroke-sidebar-primary" />
      </Match>
      <Match when={props.state() === "dirty"}>
        <Bookmark class="size-3 shrink-0 fill-sidebar-primary/50 stroke-sidebar-primary/50 animate-pulse" />
      </Match>
      <Match when={props.state() === "local"}>
        <Bookmark
          class="size-3 shrink-0 transition-opacity duration-150"
          style={{ opacity: props.hover() ? 0.75 : 0.4 }}
        />
      </Match>
    </Switch>
  );
}

function CursorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      {/* Outline + fill so the cursor reads on both light and dark surfaces */}
      <path
        d="M5 3 L5 19 L9 15 L11.5 21 L14 20 L11.5 14 L17 14 Z"
        fill="white"
        stroke="black"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/**
 * Phone preview shown next to the desktop window. Layout responds to the
 * desktop's `compact` state — when the window is narrow enough that the
 * voice pane folded away, the phone hides its Voice tab too, demonstrating
 * the workspace sync. Synced badge pulses while the saved state is current.
 */
function PhonePreview(props: { compact: boolean; synced: boolean }) {
  return (
    <div class="flex items-center gap-3 shrink-0">
      {/* Phone */}
      <div
        class="relative rounded-[20px] border border-border/80 bg-card overflow-hidden shrink-0"
        style={{
          width: "150px",
          height: "260px",
          "box-shadow":
            "0 12px 32px oklch(0 0 0 / 0.5), 0 0 0 4px oklch(0.15 0 0), 0 0 0 5px color-mix(in oklch, var(--sidebar-primary) 35%, transparent)",
        }}
      >
        {/* Notch */}
        <div class="absolute left-1/2 top-0 -translate-x-1/2 h-3 w-12 rounded-b-lg bg-background z-10" />

        {/* Status bar */}
        <div class="flex items-center justify-between px-3 pt-1 pb-1">
          <span class="text-[8px] font-semibold text-foreground">9:41</span>
          <span class="text-[8px] text-muted-foreground">●●●</span>
        </div>

        {/* Workspace tabs */}
        <div class="flex items-center gap-1 px-2 pb-1.5 border-b border-border/60">
          <div class="flex items-center gap-1 rounded-md bg-sidebar-accent px-1.5 py-0.5">
            <Bookmark
              class="size-2 fill-sidebar-primary stroke-sidebar-primary"
            />
            <span class="text-[7px] font-semibold text-sidebar-accent-foreground">Daily</span>
          </div>
          <Show when={!props.compact}>
            <span class="text-[7px] text-muted-foreground px-1">Voice</span>
          </Show>
          <span class="text-[7px] text-muted-foreground/50 px-1 ml-auto">+</span>
        </div>

        {/* Channel header */}
        <div class="flex items-center gap-1 px-2 py-1.5 border-b border-border/60">
          <Hash class="size-2.5 text-muted-foreground/60" />
          <span class="text-[8px] font-semibold text-foreground">general</span>
          <span class="ml-auto text-[7px] text-muted-foreground">24</span>
        </div>

        {/* Messages — when compact, an extra message fits since voice tab is gone */}
        <div class="flex flex-col gap-1.5 px-2 py-2">
          <PhoneMessage initial="A" color="oklch(0.55 0.18 150)" name="Alex" text="voice plugin v0.5 shipped" />
          <PhoneMessage initial="S" color="oklch(0.55 0.20 30)" name="Sam" text="running buttery on the homelab" />
          <PhoneMessage initial="J" color="var(--sidebar-primary)" name="Jordan" text="moderation update is clean" />
          <Show when={props.compact}>
            <PhoneMessage initial="K" color="oklch(0.55 0.18 280)" name="Kai" text="loving the new layout" />
          </Show>
        </div>

        {/* Bottom nav */}
        <div class="absolute bottom-0 left-0 right-0 flex items-center justify-around border-t border-border/60 bg-card py-1.5">
          <Home class="size-3 text-foreground" />
          <Hash class="size-3 text-muted-foreground/60" />
          <Inbox class="size-3 text-muted-foreground/60" />
          <Users class="size-3 text-muted-foreground/60" />
        </div>
      </div>

      {/* "Synced" call-out next to the phone */}
      <div class="flex flex-col gap-2 max-w-[150px]">
        <div
          class="flex items-center gap-1.5 rounded-full border px-2 py-1 self-start transition-all duration-300"
          style={{
            background: props.synced
              ? "color-mix(in oklch, oklch(0.7 0.18 145) 16%, transparent)"
              : "color-mix(in oklch, var(--muted) 60%, transparent)",
            "border-color": props.synced
              ? "color-mix(in oklch, oklch(0.7 0.18 145) 35%, transparent)"
              : "var(--border)",
          }}
        >
          <Check
            class="size-3"
            style={{
              color: props.synced
                ? "oklch(0.78 0.18 150)"
                : "var(--muted-foreground)",
            }}
          />
          <span
            class="text-[10px] font-semibold"
            style={{
              color: props.synced
                ? "oklch(0.78 0.18 150)"
                : "var(--muted-foreground)",
            }}
          >
            {props.synced ? "Synced" : "Syncing…"}
          </span>
        </div>
        <div class="flex items-center gap-1.5 text-[11px] text-foreground">
          <Smartphone class="size-3.5 text-sidebar-primary shrink-0" />
          <span class="font-semibold leading-tight">Workspaces follow you</span>
        </div>
        <p class="text-[10px] text-muted-foreground leading-snug">
          Save once on desktop. Open the same layout on mobile, web, or Electron.
        </p>
      </div>
    </div>
  );
}

function PhoneMessage(props: { initial: string; color: string; name: string; text: string }) {
  return (
    <div class="flex items-start gap-1.5">
      <div
        class="size-3.5 shrink-0 rounded-full flex items-center justify-center text-[6px] font-bold text-white"
        style={{ background: props.color }}
      >
        {props.initial}
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-[7px] font-semibold text-foreground">{props.name}</div>
        <p class="text-[7px] leading-tight text-muted-foreground truncate">{props.text}</p>
      </div>
    </div>
  );
}
