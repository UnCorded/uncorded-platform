import { Show, createEffect, createSignal, on } from "solid-js";
import { Check, ClipboardCheck, FolderOpen, Loader2, Play } from "lucide-solid";
import type { DevPlugin } from "@uncorded/electron-bridge";
import { PLUGIN_SLUG_RE } from "@uncorded/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { account } from "@/stores/auth";
import {
  agentDetection,
  createDevPlugin,
  launchDevPluginAgent,
  openDevPluginFolder,
} from "@/stores/plugin-dev";

// New Plugin dialog — collects the idea, scaffolds the workspace folder, and
// hands off to an agent. NOT an editor: the success state's whole job is to
// get the user from "described it" to "agent is working on it" in one click.

const SLUG_MAX = 50;

/** Display name → slug suggestion: lowercase, spaces→hyphens, strip the rest. */
function deriveSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, SLUG_MAX);
}

function slugError(slug: string): string | null {
  if (slug.length === 0) return null; // empty shows the required hint on submit
  if (slug.length < 2 || !PLUGIN_SLUG_RE.test(slug)) {
    return "Lowercase letters, digits, and single hyphens; must start with a letter.";
  }
  return null;
}

export function NewPluginDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [displayName, setDisplayName] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugTouched, setSlugTouched] = createSignal(false);
  const [description, setDescription] = createSignal("");
  const [idea, setIdea] = createSignal("");
  const [pluginType, setPluginType] = createSignal<"standalone" | "extension">("standalone");
  const [extendsSlug, setExtendsSlug] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<{ plugin: DevPlugin; promptCopied: boolean } | null>(null);
  const [launching, setLaunching] = createSignal(false);

  // Reset everything when the dialog closes so the next open starts fresh.
  createEffect(
    on(
      () => props.open,
      (isOpen) => {
        if (isOpen) return;
        setDisplayName("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setIdea("");
        setPluginType("standalone");
        setExtendsSlug("");
        setSubmitting(false);
        setSubmitError(null);
        setCreated(null);
        setLaunching(false);
      },
      { defer: true },
    ),
  );

  // Live slug derivation tracks the display name until the user edits the
  // slug field directly — then their choice wins.
  const onDisplayNameInput = (value: string) => {
    setDisplayName(value);
    if (!slugTouched()) setSlug(deriveSlug(value));
  };

  const liveSlugError = () => slugError(slug());

  const canSubmit = () =>
    !submitting() &&
    displayName().trim().length > 0 &&
    slug().length >= 2 &&
    liveSlugError() === null &&
    description().trim().length > 0 &&
    (pluginType() !== "extension" || slugError(extendsSlug()) === null && extendsSlug().length >= 2);

  const submit = async () => {
    if (!canSubmit()) return;
    setSubmitting(true);
    setSubmitError(null);
    const author = account()?.display_name?.trim() || "plugin author";
    const result = await createDevPlugin({
      slug: slug(),
      displayName: displayName().trim(),
      description: description().trim(),
      idea: idea().trim(),
      author,
      pluginType: pluginType(),
      ...(pluginType() === "extension" ? { extendsSlug: extendsSlug() } : {}),
    });
    setSubmitting(false);
    if (result.ok) {
      setCreated({ plugin: result.plugin, promptCopied: result.promptCopied });
    } else {
      setSubmitError(result.message);
    }
  };

  const startAgent = async () => {
    const c = created();
    if (c === null || launching()) return;
    setLaunching(true);
    await launchDevPluginAgent(c.plugin.slug);
    setLaunching(false);
    props.onOpenChange(false);
  };

  const fieldLabel = "text-xs font-medium text-muted-foreground";
  const textareaClass =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* p-5: DialogContent has no default padding (repo convention is
          consumer-owned, see avatar-crop-dialog). */}
      <DialogContent class="sm:max-w-lg p-5">
        <Show
          when={created()}
          fallback={
            <>
              <DialogHeader>
                <DialogTitle>New plugin</DialogTitle>
                <DialogDescription>
                  Describe the plugin; UnCorded scaffolds a working starter and a
                  ready-to-go prompt for your coding agent.
                </DialogDescription>
              </DialogHeader>

              <form
                class="mt-4 flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div class="flex flex-col gap-1">
                  <label class={fieldLabel} for="plugin-dev-name">Name</label>
                  <Input
                    id="plugin-dev-name"
                    value={displayName()}
                    maxLength={100}
                    placeholder="Trip Planner"
                    onInput={(e) => onDisplayNameInput(e.currentTarget.value)}
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label class={fieldLabel} for="plugin-dev-slug">Slug</label>
                  <Input
                    id="plugin-dev-slug"
                    value={slug()}
                    maxLength={SLUG_MAX}
                    placeholder="trip-planner"
                    class="font-mono"
                    onInput={(e) => {
                      setSlugTouched(true);
                      setSlug(e.currentTarget.value);
                    }}
                  />
                  <Show when={liveSlugError()}>
                    {(err) => <p class="text-xs text-destructive">{err()}</p>}
                  </Show>
                  <p class="text-xs text-muted-foreground/70">
                    Permanent identity — folder name, database, URLs.
                  </p>
                </div>

                <div class="flex flex-col gap-1">
                  <label class={fieldLabel} for="plugin-dev-description">One-line description</label>
                  <Input
                    id="plugin-dev-description"
                    value={description()}
                    maxLength={500}
                    placeholder="Plan trips together with votes and checklists."
                    onInput={(e) => setDescription(e.currentTarget.value)}
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label class={fieldLabel} for="plugin-dev-idea">What should it do?</label>
                  <textarea
                    id="plugin-dev-idea"
                    class={textareaClass}
                    rows={4}
                    maxLength={20000}
                    placeholder="Members propose destinations, everyone votes, the winner gets a shared packing checklist…"
                    value={idea()}
                    onInput={(e) => setIdea(e.currentTarget.value)}
                  />
                  <p class="text-xs text-muted-foreground/70">
                    Goes verbatim into the agent prompt — the more specific, the better.
                  </p>
                </div>

                <div class="flex gap-3">
                  <div class="flex flex-col gap-1 flex-1">
                    <label class={fieldLabel} for="plugin-dev-type">Type</label>
                    <select
                      id="plugin-dev-type"
                      class="border border-input bg-background hover:bg-accent rounded-md px-2 h-8 text-sm w-full"
                      value={pluginType()}
                      onChange={(e) => setPluginType(e.currentTarget.value as "standalone" | "extension")}
                    >
                      <option value="standalone">Standalone</option>
                      <option value="extension">Extension</option>
                    </select>
                  </div>
                  <Show when={pluginType() === "extension"}>
                    <div class="flex flex-col gap-1 flex-1">
                      <label class={fieldLabel} for="plugin-dev-extends">Extends (base slug)</label>
                      <Input
                        id="plugin-dev-extends"
                        value={extendsSlug()}
                        maxLength={SLUG_MAX}
                        placeholder="text-channels"
                        class="font-mono"
                        onInput={(e) => setExtendsSlug(e.currentTarget.value)}
                      />
                    </div>
                  </Show>
                </div>

                <Show when={submitError()}>
                  {(err) => <p class="text-sm text-destructive">{err()}</p>}
                </Show>

                <div class="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!canSubmit()}>
                    <Show when={submitting()}>
                      <Loader2 class="size-4 animate-spin" />
                    </Show>
                    Create plugin
                  </Button>
                </div>
              </form>
            </>
          }
        >
          {(c) => (
            <>
              <DialogHeader>
                <DialogTitle class="flex items-center gap-2">
                  <Check class="size-5 text-green-500" />
                  {c().plugin.displayName} scaffolded
                </DialogTitle>
                <DialogDescription>
                  <Show
                    when={c().promptCopied}
                    fallback={"A working starter plugin is ready. Use Copy prompt on its row to grab the agent prompt."}
                  >
                    <span class="inline-flex items-center gap-1.5">
                      <ClipboardCheck class="size-3.5" />
                      Agent prompt copied to your clipboard.
                    </span>
                  </Show>
                </DialogDescription>
              </DialogHeader>

              <div class="mt-4 flex flex-col gap-2">
                <p class="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                  {c().plugin.path}
                </p>
                <p class="text-xs text-muted-foreground">
                  Paste the prompt into any coding agent, or start one right here.
                  PROMPT.md and AGENTS.md inside the folder carry everything the
                  agent needs.
                </p>
              </div>

              <div class="mt-3 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => void openDevPluginFolder(c().plugin.slug)}>
                  <FolderOpen class="size-4" />
                  Open folder
                </Button>
                <Show when={agentDetection().found}>
                  <Button type="button" disabled={launching()} onClick={() => void startAgent()}>
                    <Show when={launching()} fallback={<Play class="size-4" />}>
                      <Loader2 class="size-4 animate-spin" />
                    </Show>
                    Start agent
                  </Button>
                </Show>
                <Button
                  type="button"
                  variant={agentDetection().found ? "ghost" : "default"}
                  onClick={() => props.onOpenChange(false)}
                >
                  Done
                </Button>
              </div>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}
