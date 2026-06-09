import { createPlugin } from "@uncorded/plugin-sdk";

// Foundry VTT is a "standalone" plugin: it owns no data and runs no logic of
// its own. Its entire job is to surface a single sidebar entry whose panel
// loads the reverse-proxied Foundry server in an iframe. All proxy auth,
// approval, and forwarding live in the runtime (see runtime/src/http/proxy.ts
// and runtime/src/http/proxy-ws.ts); the manifest's `proxy_mounts` declares
// the `foundry` mount that the panel bootstraps against.
const plugin = createPlugin();

// One static sidebar item. No per-user or per-channel variation — every member
// who can see the section gets the same "Foundry" entry that opens the panel.
plugin.handle("sidebar.items", async () => ({
  items: [
    {
      id: "foundry",
      label: "Foundry",
      icon: "Dice6",
      panelType: "plugin" as const,
      slug: "foundry-vtt",
      section: "Tabletop",
    },
  ],
}));
