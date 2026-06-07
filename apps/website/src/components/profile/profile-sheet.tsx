import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { CoViewRenderMode, CoViewVisibility } from "@uncorded/protocol";
import { CheckCircle2, Lock, Upload, X } from "lucide-solid";
import {
  ALL_REDACTION_KEYS,
  REDACTION_LABELS,
  getCoViewDefaults,
  getSpecCoViewDefaults,
  isAlwaysRedacted,
  setCoViewDefaults,
  type CoViewRedactionKey,
} from "@/co-view/co-view-defaults";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import * as central from "@/api/central";
import { BASE_URL as CENTRAL_URL } from "@/api/central";
import { account, logout, setAccount } from "@/stores/auth";
import { AvatarCropDialog } from "@/components/profile/avatar-crop-dialog";
import { ApiError } from "@/api/types";
import { cn } from "@/lib/utils";
import { GoogleIcon, DiscordIcon, GitHubIcon } from "@/components/auth/oauth-icons";

// Mirror of apps/central/src/usernames.ts. See auth-page.tsx for why this is
// not imported from Central.
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

function formatCooldownRemaining(availableAt: string | null): string | null {
  if (!availableAt) return null;
  const ms = new Date(availableAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days === 1) return "1 day";
  return `${days} days`;
}

type ProfileSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProfileSheet(props: ProfileSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        class="flex w-[22rem] flex-col gap-0 p-0 sm:max-w-[22rem]"
      >
        {/* Header */}
        <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
          <SheetTitle class="text-sm font-semibold">Profile</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>
        </SheetHeader>

        {/* Scrollable body */}
        <div class="flex-1 overflow-y-auto">
          <AccountSection />
          <Divider />
          <CoViewSection />
          <Divider />
          <AppearanceSection />
          <Divider />
          <DangerZone onClose={() => props.onOpenChange(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Shared ─────────────────────────────────────────────────────────────────────

function Divider() {
  return <div class="h-px bg-border" />;
}

function SectionLabel(props: { label: string }) {
  return (
    <p class="px-4 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      {props.label}
    </p>
  );
}

// ── Account section ────────────────────────────────────────────────────────────

function AccountSection() {
  const [displayName, setDisplayName] = createSignal(account()?.display_name ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle");
  const [uploading, setUploading] = createSignal(false);
  const [uploadError, setUploadError] = createSignal<string | null>(null);
  // Source file picked from the file input — drives the crop dialog. Null
  // when the dialog is closed; the dialog revokes its own object URLs on
  // close so we don't carry that responsibility here.
  const [pendingFile, setPendingFile] = createSignal<File | null>(null);

  const avatarUrl = () => account()?.avatar_url ?? null;
  const userId = () => account()?.id ?? "";

  async function saveDisplayName() {
    if (saveStatus() === "saving") return;
    setSaveStatus("saving");
    try {
      const updated = await central.patchProfile({ display_name: displayName() });
      setAccount(updated);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }

  function handleFilePicked(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    // Reset the input so re-picking the same file re-opens the crop dialog.
    e.currentTarget.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setUploadError("Unsupported file type. Use JPEG, PNG, WebP, or GIF.");
      return;
    }
    setUploadError(null);
    setPendingFile(file);
  }

  async function handleCropConfirm(cropped: Blob) {
    setPendingFile(null);
    setUploadError(null);
    setUploading(true);
    try {
      // Crop output is always image/png — the backend allow-list includes
      // PNG, so we don't need to negotiate content_type with the original
      // file's MIME type.
      const contentType = "image/png";
      const { upload_url, upload_fields, final_url, max_bytes } =
        await central.getAvatarUploadUrl(contentType);
      if (cropped.size > max_bytes) {
        throw new Error(
          `Avatar is too large (${(cropped.size / 1024 / 1024).toFixed(1)} MB). Max ${(max_bytes / 1024 / 1024).toFixed(0)} MB.`,
        );
      }
      // Presigned POST: every signed field goes in the FormData first, then
      // the file last. R2 enforces the content-length-range from the signed
      // policy and rejects any upload that doesn't match — even if this URL
      // leaks, the cap travels with it.
      const form = new FormData();
      for (const [k, v] of Object.entries(upload_fields)) form.append(k, v);
      form.append("file", cropped);
      const res = await fetch(upload_url, { method: "POST", body: form });
      if (!res.ok) throw new Error(`R2 upload failed: ${res.status} ${res.statusText}`);
      // R2 URL is keyed on user id, so it's stable across uploads. Append
      // a cache-busting query string so the new image renders immediately
      // on this client and any other subsequent fetch — the value is
      // harmless on Cloudflare's CDN side (treated as same object).
      const cacheBusted = `${final_url}?v=${String(Date.now())}`;
      const updated = await central.patchProfile({ avatar_url: cacheBusted });
      setAccount(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setUploadError(msg);
      console.error("[avatar upload]", err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <section>
      {/* Avatar hero */}
      <div
        class="flex flex-col items-center gap-3 border-b border-border px-4 py-6"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklch, var(--sidebar-primary) 12%, transparent), transparent)",
        }}
      >
        <div class="relative">
          <Avatar
            class="size-20 rounded-xl text-lg"
            userId={userId()}
            name={account()?.display_name ?? ""}
            src={avatarUrl()}
          />
          <Show when={uploading()}>
            <div class="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
              <div class="size-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </div>
          </Show>
        </div>

        <div class="text-center">
          <p class="font-semibold">{account()?.display_name}</p>
          <Show when={account()?.username}>
            <p class="text-xs text-muted-foreground font-mono">@{account()?.username}</p>
          </Show>
          <p class="text-sm text-muted-foreground">{account()?.email}</p>
          <div class="mt-2">
            <Show
              when={account()?.email_verified}
              fallback={
                <span class="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                  Unverified
                </span>
              }
            >
              <span class="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
                <CheckCircle2 class="size-3" />
                Email verified
              </span>
            </Show>
          </div>
        </div>

        <div class="flex flex-col items-center gap-1">
          <label class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              class="sr-only"
              onChange={handleFilePicked}
            />
            <Upload class="size-3" />
            {uploading() ? "Uploading…" : "Upload photo"}
          </label>
          <Show when={uploadError()}>
            <p class="text-xs text-destructive text-center max-w-[200px]">{uploadError()}</p>
          </Show>
        </div>
      </div>
      <AvatarCropDialog
        open={pendingFile() !== null}
        file={pendingFile()}
        onCancel={() => setPendingFile(null)}
        onConfirm={(blob) => void handleCropConfirm(blob)}
      />

      {/* Display name */}
      <div class="space-y-1.5 px-4 py-3">
        <label class="text-xs font-medium text-muted-foreground">Display name</label>
        <div class="flex gap-2">
          <Input
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
            class="flex-1 h-8 text-sm"
          />
          <Button
            size="sm"
            class="h-8 shrink-0"
            disabled={displayName() === account()?.display_name || saveStatus() === "saving"}
            onClick={() => void saveDisplayName()}
          >
            {saveStatus() === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
        <Show when={saveStatus() === "saved"}>
          <p class="text-xs text-emerald-500">Saved</p>
        </Show>
        <Show when={saveStatus() === "error"}>
          <p class="text-xs text-destructive">Failed to save</p>
        </Show>
      </div>

      <UsernameRow />
      <LinkedProvidersRow />
      <EmailRow />
      <PasswordRow />
    </section>
  );
}

// ── Username row ───────────────────────────────────────────────────────────────

function UsernameRow() {
  const [draft, setDraft] = createSignal(account()?.username ?? "");
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = createSignal<string | null>(null);

  const cooldownLabel = createMemo(() =>
    formatCooldownRemaining(account()?.username_change_available_at ?? null),
  );
  const isLocked = (): boolean => cooldownLabel() !== null;

  const inlineHint = (): string | null => {
    if (draft() === (account()?.username ?? "")) return null;
    return validateUsernameClient(draft());
  };

  async function save() {
    if (status() === "saving") return;
    const next = draft().trim().toLowerCase();
    const err = validateUsernameClient(next);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStatus("saving");
    try {
      const updated = await central.patchProfile({ username: next });
      setAccount(updated);
      setDraft(updated.username);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to update username.";
      setError(msg);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <div class="space-y-1.5 px-4 py-3 border-t border-border">
      <label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        Username
        <Show when={isLocked()}>
          <Lock class="size-3" />
        </Show>
      </label>
      <div class="flex gap-2">
        <Input
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value.toLowerCase())}
          disabled={isLocked() || status() === "saving"}
          minLength={USERNAME_MIN}
          maxLength={USERNAME_MAX}
          autocomplete="username"
          class="flex-1 h-8 text-sm font-mono"
        />
        <Button
          size="sm"
          class="h-8 shrink-0"
          disabled={
            isLocked() ||
            draft() === (account()?.username ?? "") ||
            status() === "saving"
          }
          onClick={() => void save()}
        >
          {status() === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      <Show
        when={!isLocked() && error() === null && inlineHint() === null}
        fallback={
          <Show when={inlineHint()}>
            <p class="text-xs text-destructive">{inlineHint()}</p>
          </Show>
        }
      >
        <p class="text-xs text-muted-foreground">
          One change allowed per 30 days. Lowercase letters, numbers, underscores.
        </p>
      </Show>
      <Show when={isLocked()}>
        <p class="text-xs text-muted-foreground">
          You can change your username again in {cooldownLabel()}.
        </p>
      </Show>
      <Show when={status() === "saved"}>
        <p class="text-xs text-emerald-500">Saved</p>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-destructive">{error()}</p>
      </Show>
    </div>
  );
}

// ── Email row ──────────────────────────────────────────────────────────────────

function EmailRow() {
  const [draft, setDraft] = createSignal(account()?.email ?? "");
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [status, setStatus] = createSignal<"idle" | "saving" | "sent" | "error">("idle");
  const [error, setError] = createSignal<string | null>(null);

  function startEdit() {
    setDraft(account()?.email ?? "");
    setCurrentPassword("");
    setError(null);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setError(null);
    setCurrentPassword("");
  }

  async function save() {
    if (status() === "saving") return;
    const next = draft().trim();
    if (!next.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (currentPassword().length === 0) {
      setError("Enter your current password to change your email.");
      return;
    }
    setError(null);
    setStatus("saving");
    try {
      const updated = await central.patchProfile({
        email: next,
        current_password: currentPassword(),
      });
      setAccount(updated);
      setStatus("sent");
      setEditing(false);
      setCurrentPassword("");
      setTimeout(() => setStatus("idle"), 5000);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to update email.";
      setError(msg);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <div class="space-y-1.5 px-4 py-3 border-t border-border">
      <div class="flex items-center justify-between">
        <label class="text-xs font-medium text-muted-foreground">Email address</label>
        <Show when={!editing()}>
          <button
            type="button"
            class="text-xs text-sidebar-primary hover:underline"
            onClick={startEdit}
          >
            Change
          </button>
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={<Input value={account()?.email ?? ""} disabled class="h-8 text-sm" />}
      >
        <Input
          type="email"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          autocomplete="email"
          class="h-8 text-sm"
        />
        <Input
          type="password"
          placeholder="Current password"
          value={currentPassword()}
          onInput={(e) => setCurrentPassword(e.currentTarget.value)}
          autocomplete="current-password"
          class="h-8 text-sm"
        />
        <p class="text-xs text-muted-foreground">
          We'll send a verification link to your new address. You'll stay signed in,
          but the new address won't be active until you click the link.
        </p>
        <div class="flex gap-2">
          <Button
            size="sm"
            class="h-8 flex-1"
            disabled={status() === "saving"}
            onClick={() => void save()}
          >
            {status() === "saving" ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="h-8"
            disabled={status() === "saving"}
            onClick={cancel}
          >
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={status() === "sent"}>
        <p class="text-xs text-emerald-500">Verification email sent — check your inbox.</p>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-destructive">{error()}</p>
      </Show>
    </div>
  );
}

// ── Password row ───────────────────────────────────────────────────────────────

function PasswordRow() {
  const [editing, setEditing] = createSignal(false);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = createSignal<string | null>(null);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
    setError(null);
  }

  async function save() {
    if (status() === "saving") return;
    if (newPassword().length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword() !== confirm()) {
      setError("Passwords do not match.");
      return;
    }
    if (currentPassword().length === 0) {
      setError("Enter your current password.");
      return;
    }
    setError(null);
    setStatus("saving");
    try {
      const updated = await central.patchProfile({
        current_password: currentPassword(),
        new_password: newPassword(),
      });
      setAccount(updated);
      setStatus("saved");
      reset();
      setEditing(false);
      setTimeout(() => setStatus("idle"), 3000);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to change password.";
      setError(msg);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <div class="space-y-1.5 px-4 py-3 pb-4 border-t border-border">
      <div class="flex items-center justify-between">
        <label class="text-xs font-medium text-muted-foreground">Password</label>
        <Show when={!editing()}>
          <button
            type="button"
            class="text-xs text-sidebar-primary hover:underline"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={<Input value="••••••••" disabled type="password" class="h-8 text-sm" />}
      >
        <Input
          type="password"
          placeholder="Current password"
          value={currentPassword()}
          onInput={(e) => setCurrentPassword(e.currentTarget.value)}
          autocomplete="current-password"
          class="h-8 text-sm"
        />
        <Input
          type="password"
          placeholder="New password (min 8 characters)"
          value={newPassword()}
          onInput={(e) => setNewPassword(e.currentTarget.value)}
          autocomplete="new-password"
          minLength={8}
          class="h-8 text-sm"
        />
        <Input
          type="password"
          placeholder="Confirm new password"
          value={confirm()}
          onInput={(e) => setConfirm(e.currentTarget.value)}
          autocomplete="new-password"
          class="h-8 text-sm"
        />
        <p class="text-xs text-muted-foreground">
          Changing your password signs out other devices.
        </p>
        <div class="flex gap-2">
          <Button
            size="sm"
            class="h-8 flex-1"
            disabled={status() === "saving"}
            onClick={() => void save()}
          >
            {status() === "saving" ? "Saving…" : "Update password"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="h-8"
            disabled={status() === "saving"}
            onClick={() => {
              reset();
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={status() === "saved"}>
        <p class="text-xs text-emerald-500">Password updated.</p>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-destructive">{error()}</p>
      </Show>
    </div>
  );
}

// ── Linked providers ───────────────────────────────────────────────────────────

type ProviderId = "google" | "discord" | "github";
const PROVIDERS: ReadonlyArray<{ id: ProviderId; label: string; Icon: () => JSX.Element }> = [
  { id: "google", label: "Google", Icon: GoogleIcon },
  { id: "discord", label: "Discord", Icon: DiscordIcon },
  { id: "github", label: "GitHub", Icon: GitHubIcon },
];

function LinkedProvidersRow() {
  const [busy, setBusy] = createSignal<ProviderId | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const isLinked = (id: ProviderId): boolean =>
    (account()?.providers ?? []).includes(id);

  function startLink(id: ProviderId) {
    // Browser-level navigation; Central handles the OAuth dance with the
    // session cookie and redirects back to POST_LOGIN_REDIRECT, after which
    // bootstrap() re-fetches the profile and the icon flips to "linked".
    window.location.href = `${CENTRAL_URL}/v1/auth/link/${id}`;
  }

  async function unlink(id: ProviderId) {
    if (busy()) return;
    setError(null);
    setBusy(id);
    try {
      await central.unlinkProvider(id);
      const updated = await central.getProfile();
      setAccount(updated);
    } catch (e) {
      // Central refuses to unlink the last auth method (≥2 required) — surface
      // that message verbatim so the user understands why.
      const msg = e instanceof ApiError ? e.message : "Failed to unlink provider.";
      setError(msg);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="space-y-1.5 px-4 py-3 border-t border-border">
      <label class="text-xs font-medium text-muted-foreground">Connected accounts</label>
      <div class="flex justify-center gap-2">
        {PROVIDERS.map(({ id, label, Icon }) => {
          const linked = () => isLinked(id);
          return (
            <button
              type="button"
              aria-label={linked() ? `Disconnect ${label}` : `Connect ${label}`}
              aria-pressed={linked()}
              disabled={busy() !== null}
              onClick={() => (linked() ? void unlink(id) : startLink(id))}
              class={cn(
                "flex size-9 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                linked()
                  ? "border-sidebar-primary/30 bg-sidebar-primary/10 text-foreground hover:bg-sidebar-primary/20"
                  : "border-border bg-muted/40 text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground",
              )}
            >
              <Icon />
            </button>
          );
        })}
      </div>
      <Show when={error()}>
        <p class="text-xs text-destructive text-center">{error()}</p>
      </Show>
    </div>
  );
}

// ── Co-View defaults ───────────────────────────────────────────────────────────

function CoViewSection() {
  const accountId = createMemo(() => account()?.id ?? null);
  const initial = createMemo(() => {
    const id = accountId();
    return id ? getCoViewDefaults(id) : getSpecCoViewDefaults();
  });

  const [visibility, setVisibility] = createSignal<CoViewVisibility>(initial().visibility);
  const [renderMode, setRenderMode] = createSignal<CoViewRenderMode>(initial().renderMode);
  const [redactions, setRedactions] = createSignal<CoViewRedactionKey[]>(
    initial().redactions.slice(),
  );
  const [status, setStatus] = createSignal<"idle" | "saved">("idle");

  function toggleRedaction(key: CoViewRedactionKey): void {
    if (isAlwaysRedacted(key)) return;
    const set = new Set(redactions());
    if (set.has(key)) set.delete(key);
    else set.add(key);
    const next: CoViewRedactionKey[] = [];
    for (const k of ALL_REDACTION_KEYS) if (set.has(k)) next.push(k);
    setRedactions(next);
  }

  function save(): void {
    const id = accountId();
    if (!id) return;
    setCoViewDefaults(id, {
      visibility: visibility(),
      renderMode: renderMode(),
      redactions: redactions(),
    });
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 2000);
  }

  function resetToSpec(): void {
    const spec = getSpecCoViewDefaults();
    setVisibility(spec.visibility);
    setRenderMode(spec.renderMode);
    setRedactions(spec.redactions.slice());
  }

  return (
    <section>
      <SectionLabel label="Co-View defaults" />
      <div class="px-4 pb-4">
        <p class="mb-3 text-xs text-muted-foreground">
          Pre-fills for the start-session sheet. Saved on this device — won't sync across devices.
        </p>

        <div class="mb-3 space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Visibility</p>
          <div class="flex flex-col gap-1">
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="cv-visibility"
                checked={visibility() === "private"}
                onChange={() => setVisibility("private")}
                class="size-4 accent-primary"
              />
              Private — only invited members
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="cv-visibility"
                checked={visibility() === "public"}
                onChange={() => setVisibility("public")}
                class="size-4 accent-primary"
              />
              Public — everyone, except blocked
            </label>
          </div>
        </div>

        <div class="mb-3 space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Render mode</p>
          <div class="flex flex-col gap-1">
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="cv-render"
                checked={renderMode() === "as-viewer"}
                onChange={() => setRenderMode("as-viewer")}
                class="size-4 accent-primary"
              />
              As viewer (recommended)
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="cv-render"
                checked={renderMode() === "as-host"}
                onChange={() => setRenderMode("as-host")}
                class="size-4 accent-primary"
              />
              As host
            </label>
          </div>
        </div>

        <div class="mb-3 space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">Redactions</p>
          <div class="flex flex-col gap-1">
            <For each={ALL_REDACTION_KEYS}>
              {(key) => {
                const checked = () => redactions().includes(key);
                const disabled = isAlwaysRedacted(key);
                return (
                  <label class="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked()}
                      disabled={disabled}
                      onChange={() => toggleRedaction(key)}
                      class="size-4 rounded border-border accent-primary disabled:opacity-60"
                    />
                    <span class={disabled ? "text-muted-foreground" : ""}>
                      {REDACTION_LABELS[key]}
                    </span>
                  </label>
                );
              }}
            </For>
          </div>
        </div>

        <div class="flex gap-2">
          <Button size="sm" class="h-8 flex-1" onClick={save} disabled={!accountId()}>
            Save defaults
          </Button>
          <Button size="sm" variant="outline" class="h-8" onClick={resetToSpec}>
            Reset
          </Button>
        </div>
        <Show when={status() === "saved"}>
          <p class="mt-2 text-xs text-emerald-500">Saved on this device.</p>
        </Show>
      </div>
    </section>
  );
}

// ── Appearance ─────────────────────────────────────────────────────────────────

function AppearanceSection() {
  return (
    <section>
      <SectionLabel label="Appearance" />
      <div class="px-4 pb-4">
        <div class="rounded-lg border border-border bg-muted/30 px-3 py-3">
          <p class="text-sm text-muted-foreground">Theme settings coming soon.</p>
          <p class="mt-0.5 text-xs text-muted-foreground/60">
            The shell ships in a single dark theme for Phase 1.
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Danger zone ────────────────────────────────────────────────────────────────

function DangerZone(props: { onClose: () => void }) {
  const [loggingOut, setLoggingOut] = createSignal(false);

  async function handleLogout() {
    setLoggingOut(true);
    props.onClose();
    await logout();
  }

  return (
    <section>
      <SectionLabel label="Danger zone" />
      <div class="px-4 pb-6">
        <div class="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
          <p class="mb-3 text-xs text-muted-foreground">
            You will be signed out and returned to the login screen.
          </p>
          <Button
            variant="destructive"
            size="sm"
            class="w-full"
            disabled={loggingOut()}
            onClick={() => void handleLogout()}
          >
            {loggingOut() ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </div>
    </section>
  );
}
