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

## Cloudflare Pages settings

Create once (Workers & Pages → Create → Pages → Connect to Git →
`UnCorded/uncorded-platform`), then it auto-deploys on push:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `docs/site` |
| Build command | `bun run build` |
| Build output directory | `.vitepress/dist` |
| Env var | `NODE_VERSION = 20` |

- A committed `bun.lock` makes Cloudflare use Bun for install automatically.
- Custom domain: add `docs.uncorded.app` under the Pages project's **Custom
  domains** (DNS is already on Cloudflare, so the CNAME is created for you).
- Do **not** enable HTML "Auto Minify" — it strips the comments VitePress/Vue
  need for hydration.

## Adding pages

Drop a `.md` file under `docs/site/` and add it to the `sidebar`/`nav` in
`.vitepress/config.ts`. Keep docs in lockstep with the SDK: when the SDK
surface changes, update the relevant page in the **same** PR.
