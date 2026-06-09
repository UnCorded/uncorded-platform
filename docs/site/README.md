# docs.uncorded.app

Source for the public SDK docs site. VitePress, built and hosted by
**Cloudflare Pages** on every push to `main`. Nothing runs locally in prod —
edit markdown, push, Cloudflare rebuilds.

## Local preview (optional)

```sh
cd docs/site
bun install
bun run dev        # http://localhost:5173
bun run build      # outputs .vitepress/dist
```

## Cloudflare Workers Builds settings

Deployed as an **assets-only Worker** via Cloudflare's Workers Builds git
integration (Workers & Pages → Create → Workers → Connect to Git →
`UnCorded/uncorded-platform`). Auto-deploys on push to `main`:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `docs/site` |
| Build command | `bun run build` |
| Deploy command | `npx wrangler deploy` |
| Env var | `NODE_VERSION = 20` |

The Worker name, compatibility date, and the assets directory
(`./.vitepress/dist`) come from [`wrangler.jsonc`](./wrangler.jsonc) — that file
is what makes `wrangler deploy` deterministic (otherwise it auto-guesses the
output dir and gets it wrong). A committed `bun.lock` makes the install step
use Bun automatically.

- Custom domain: add `docs.uncorded.app` to the `docs` Worker under
  **Settings → Domains & Routes** (DNS is already on Cloudflare, so the record
  is created for you).

## Adding pages

Drop a `.md` file under `docs/site/` and add it to the `sidebar`/`nav` in
`.vitepress/config.ts`. Keep docs in lockstep with the SDK: when the SDK
surface changes, update the relevant page in the **same** PR.
