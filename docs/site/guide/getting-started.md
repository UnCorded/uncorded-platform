# Getting started

This page builds a complete, working plugin end-to-end: a **guestbook** with a
private SQLite table, a backend that lists and adds entries, a real-time
broadcast when a new entry lands, and a sidebar panel that renders it. It uses
every layer of the SDK in miniature, so by the end you can read any of the
reference pages and know where each piece fits.

If you only want to surface a self-hosted web app behind a panel (no data, no
logic), skip this and read [Reverse-proxy plugins](/sdk/reverse-proxy) instead.

## 0. Prerequisites

- A running UnCorded server container (launched from the desktop app).
- Access to that server's data directory (`<server-data>/plugins/`) and its
  `server.json`.
- [Bun](https://bun.sh) on your machine for packaging the backend.

## 1. The folder

A plugin is a single folder named exactly its slug. Create:

```
guestbook/
  manifest.json
  backend/
    index.ts
  frontend/
    index.html
  migrations/
    001_init.sql
```

## 2. The manifest

`manifest.json` declares the slug, both entry points, and the **exact**
capabilities the plugin uses. The runtime rejects any IPC call for a capability
not listed here — declare them up front.

```json
{
  "name": "guestbook",
  "version": "0.1.0",
  "api_version": "^1.0",
  "author": "you",
  "description": "A simple server guestbook.",
  "license": "MIT",
  "type": "standalone",
  "icon": "BookOpen",
  "backend": { "entry": "backend/index.ts" },
  "frontend": { "entry": "frontend/index.html" },
  "permissions": ["data.sql:self", "broadcast.clients"],
  "sidebar": { "contributes": true, "section": "Community" }
}
```

- `type: "standalone"` — a third-party plugin that owns its own data. (Core
  plugins shipped by UnCorded use `"core"`; plugins that extend another plugin
  use `"extension"` + `extends`. See the [manifest reference](/reference/manifest).)
- `data.sql:self` — read/write the plugin's own SQLite database.
- `broadcast.clients` — push real-time events to connected clients.

Full field-by-field detail is in the [manifest reference](/reference/manifest);
the capability strings are in the [permissions reference](/reference/permissions).

## 3. The migration

SQL files in `migrations/`, run in filename order at plugin load, build your
schema. Timestamps are stored as Unix-ms integers by convention.

```sql
-- migrations/001_init.sql
CREATE TABLE entries (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_created ON entries(created_at);
```

## 4. The backend

The backend calls `createPlugin()` once, registers its request handlers
**synchronously**, then does any async setup. Handlers receive `(params, user)`
and return any JSON-serializable value; throwing surfaces an error to the caller.

```ts
// backend/index.ts
import { createPlugin } from "@uncorded/plugin-sdk";

interface Entry {
  id: string;
  author_id: string;
  message: string;
  created_at: number;
}

const plugin = createPlugin();

// Read: newest 100 entries.
plugin.handle("listEntries", async () => {
  return plugin.db.query<Entry>(
    "SELECT id, author_id, message, created_at FROM entries ORDER BY created_at DESC LIMIT 100",
  );
});

// Write: validate, insert, broadcast.
plugin.handle("addEntry", async (params, user) => {
  const message = params["message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("message is required");
  }
  if (message.length > 500) {
    throw new Error("message too long");
  }

  const entry: Entry = {
    id: crypto.randomUUID(),
    author_id: user.id,
    message: message.trim(),
    created_at: Date.now(),
  };

  await plugin.db.run(
    "INSERT INTO entries (id, author_id, message, created_at) VALUES (?, ?, ?, ?)",
    [entry.id, entry.author_id, entry.message, entry.created_at],
  );

  // Push to every connected client. The frontend SDK receives this as
  // sdk.on("entry.added", ...) — the runtime namespaces it with the slug.
  await plugin.broadcast.toAll("entry.added", entry);

  return entry;
});

// Tell the shell what to put in the sidebar.
plugin.handle("sidebar.items", async () => ({
  items: [
    {
      id: "guestbook",
      label: "Guestbook",
      icon: "BookOpen",
      panelType: "plugin" as const,
      slug: "guestbook", // must equal manifest "name"
      section: "Community",
    },
  ],
}));
```

`user` is the authenticated caller (`{ id, displayName, avatarUrl, role }`).
Use [`plugin.permissions`](/reference/backend-sdk#permissions) to gate writes by
role when you need to — the guestbook lets any member post.

## 5. The frontend

The panel is plain HTML served into a sandboxed iframe. It loads the frontend
SDK from `/sdk/plugin-frontend.js` (served by the runtime — never bundle it),
initializes, calls backend handlers with `sdk.request(action, params)`, and
listens for broadcasts with `sdk.on(event, handler)`.

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Guestbook</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; }
      #list { list-style: none; padding: 0; }
      #list li { padding: 0.5rem 0; border-bottom: 1px solid #8883; }
      form { display: flex; gap: 0.5rem; margin-top: 1rem; }
      input { flex: 1; }
    </style>
  </head>
  <body>
    <ul id="list"></ul>
    <form id="form">
      <input id="msg" placeholder="Leave a message…" maxlength="500" />
      <button type="submit">Post</button>
    </form>

    <!-- Served by the runtime. Do not bundle it yourself. -->
    <script src="/sdk/plugin-frontend.js"></script>
    <script type="module">
      const sdk = await window.UncodedPlugin.createPluginFrontend();
      const list = document.getElementById("list");

      function prepend(entry) {
        const li = document.createElement("li");
        li.textContent = entry.message;
        list.prepend(li);
      }

      // Initial load.
      const entries = await sdk.request("listEntries");
      for (const e of entries) prepend(e);

      // Live updates pushed by the backend's broadcast.toAll("entry.added", …).
      sdk.on("entry.added", (entry) => prepend(entry));

      // Post a new entry.
      document.getElementById("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const input = document.getElementById("msg");
        if (!input.value.trim()) return;
        await sdk.request("addEntry", { message: input.value });
        input.value = "";
        // No manual insert needed — the broadcast round-trips back to us.
      });
    </script>
  </body>
</html>
```

## 6. Package the backend

The runtime spawns your backend as its own subprocess with the plugin folder as
the working directory. It does **not** run `bun install` for you. Any `import`
(including `@uncorded/plugin-sdk`) must resolve against a `node_modules` present
in the installed folder.

From inside the plugin folder, add a `package.json` and install:

```sh
cd guestbook
bun init -y                       # creates package.json
bun add @uncorded/plugin-sdk      # installs the SDK + deps into node_modules
```

Ship the folder **with `node_modules` present**. (A backend that imports nothing
loads without packaging, but real plugins use the SDK and must be packaged.)

## 7. Install & run

Three things must be true, in order:

1. **Place the folder** under the server's plugin directory, named exactly the
   slug:

   ```
   <server-data>/plugins/guestbook/
   ```

2. **Register the slug** in the server's `server.json` — the runtime only loads
   plugins listed here:

   ```json
   { "installed_plugins": ["guestbook"] }
   ```

3. **Restart through the desktop app** (not `docker restart`). The runtime reads
   `installed_plugins` only at boot, so the container must be recreated. The
   desktop app owns that lifecycle.

   > ⚠️ Never `docker restart` a server on an authenticated Cloudflare tunnel —
   > the tunnel token is piped in at container-create time and a bare restart
   > silently degrades the tunnel. Always go through the desktop app.

Open the server, click **Guestbook** in the sidebar, and post. The message
appears instantly in every open client.

## What you just used

| Layer | This plugin | Reference |
| --- | --- | --- |
| Manifest + capabilities | `data.sql:self`, `broadcast.clients` | [Manifest](/reference/manifest) · [Permissions](/reference/permissions) |
| Own database | `plugin.db.query` / `plugin.db.run` | [Backend SDK → db](/reference/backend-sdk#db) |
| Request handlers | `plugin.handle("addEntry", …)` | [Backend SDK → handle](/reference/backend-sdk#handle-request) |
| Real-time push | `plugin.broadcast.toAll` → `sdk.on` | [Backend SDK → broadcast](/reference/backend-sdk#broadcast) |
| Panel UI | `createPluginFrontend()`, `sdk.request` | [Frontend SDK](/reference/frontend-sdk) |

Next: [Plugin anatomy](/guide/plugin-anatomy) breaks down every file and how the
runtime treats it.
