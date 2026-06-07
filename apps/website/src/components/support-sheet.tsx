import { createEffect, createSignal, For, on, Show } from "solid-js";
import {
  ChevronRight,
  ExternalLink,
  Mail,
  MessageCircle,
  Search,
  X,
} from "lucide-solid";

function GithubIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 016 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.28 0 .32.22.7.83.58A12.01 12.01 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";

type SupportSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Placeholders — no real Discord invite or GitHub repo URL yet.
const DISCORD_URL = "https://discord.gg/uncorded";
const GITHUB_URL = "https://github.com/uncorded/uncorded";
const SUPPORT_EMAIL = "support@uncorded.app";

const quickLinks = [
  {
    title: "Discord",
    description: "Chat with the community",
    href: DISCORD_URL,
    icon: MessageCircle,
  },
  {
    title: "GitHub",
    description: "Browse the source and open issues",
    href: GITHUB_URL,
    icon: GithubIcon,
  },
];

const faqs = [
  {
    id: "what-is",
    question: "What is UnCorded?",
    answer:
      "UnCorded is a self-hosted collaborative platform. You run a server on your own hardware in a Docker container, and every feature — chat, voice, dashboards — is a plugin. Your data lives where you put it.",
  },
  {
    id: "create-server",
    question: "How do I create a server?",
    answer:
      "Click 'Create a server' at the bottom of the sidebar and follow the wizard. You'll get setup instructions for the Docker container that runs on your own machine.",
  },
  {
    id: "join-server",
    question: "How do I join someone's server?",
    answer:
      "You need an invite from the server owner. Sign in with the same UnCorded account anywhere — your identity follows you across every server you join.",
  },
  {
    id: "what-is-plugin",
    question: "What's a plugin?",
    answer:
      "Plugins are sandboxed subprocesses that add features to a server (chat, voice, integrations). Server owners install them. Each plugin has its own database and only gets the permissions it declares up front.",
  },
  {
    id: "data-storage",
    question: "Where is my data stored?",
    answer:
      "On the server owner's hardware. UnCorded Central handles your account and the server directory, but it never sees your messages, files, or anything else inside a server.",
  },
];

export function SupportSheet(props: SupportSheetProps) {
  const [search, setSearch] = createSignal("");
  const [expandedFaq, setExpandedFaq] = createSignal<string | null>(null);

  createEffect(
    on(
      () => props.open,
      (isOpen) => {
        if (!isOpen) {
          setSearch("");
          setExpandedFaq(null);
        }
      },
      { defer: true },
    ),
  );

  const filteredFaqs = () => {
    const q = search().trim().toLowerCase();
    if (!q) return faqs;
    return faqs.filter(
      (f) =>
        f.question.toLowerCase().includes(q) ||
        f.answer.toLowerCase().includes(q),
    );
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        class="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
          <SheetTitle class="text-sm font-semibold">Help & Support</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>
        </SheetHeader>

        <div class="border-b border-border px-4 py-3">
          <div class="relative">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search for help..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              aria-label="Search for help"
              class="pl-8"
            />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Show when={!search().trim()}>
            <div class="px-4 py-4">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Quick Links
              </h3>
              <div class="flex flex-col gap-1">
                <For each={quickLinks}>
                  {(link) => (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
                    >
                      <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <link.icon class="size-4" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium text-foreground">
                          {link.title}
                        </p>
                        <p class="text-xs text-muted-foreground">
                          {link.description}
                        </p>
                      </div>
                      <ExternalLink class="size-4 shrink-0 text-muted-foreground" />
                    </a>
                  )}
                </For>
              </div>
            </div>
            <div class="h-px bg-border" />
          </Show>

          <div class="px-4 py-4">
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Frequently Asked Questions
            </h3>
            <Show
              when={filteredFaqs().length > 0}
              fallback={
                <p class="py-4 text-center text-sm text-muted-foreground">
                  No results found for "{search()}"
                </p>
              }
            >
              <div class="flex flex-col gap-1">
                <For each={filteredFaqs()}>
                  {(faq) => {
                    const isExpanded = () => expandedFaq() === faq.id;
                    return (
                      <button
                        type="button"
                        class="w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                        onClick={() =>
                          setExpandedFaq(isExpanded() ? null : faq.id)
                        }
                      >
                        <div class="flex items-center justify-between gap-2">
                          <p class="text-sm font-medium text-foreground">
                            {faq.question}
                          </p>
                          <ChevronRight
                            class="size-4 shrink-0 text-muted-foreground transition-transform"
                            classList={{ "rotate-90": isExpanded() }}
                          />
                        </div>
                        <Show when={isExpanded()}>
                          <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                            {faq.answer}
                          </p>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          <div class="h-px bg-border" />

          <div class="px-4 py-4">
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Still need help?
            </h3>
            <div class="rounded-lg border border-border p-4">
              <p class="text-sm font-medium text-foreground">Contact Support</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Our team typically responds within 24 hours.
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Mail class="size-3.5" />
                  Email Us
                </a>
                <a
                  href={DISCORD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <MessageCircle class="size-3.5" />
                  Discord
                </a>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
