const { spawnSync } = require("node:child_process");

const checks = [
  { label: "runtime + packages", args: ["x", "tsc", "--noEmit", "-p", "tsconfig.typecheck.json"] },
  { label: "central", args: ["x", "tsc", "--noEmit", "-p", "apps/central/tsconfig.json"] },
  { label: "desktop", args: ["x", "tsc", "--noEmit", "-p", "apps/desktop/tsconfig.json"] },
  { label: "website", args: ["x", "tsc", "--noEmit", "-p", "apps/website/tsconfig.json"] },
  { label: "plugin-sdk-frontend", args: ["x", "tsc", "--noEmit", "-p", "packages/plugin-sdk-frontend/tsconfig.json"] },
];

for (const check of checks) {
  console.log(`[typecheck] ${check.label}`);
  const result = spawnSync(process.execPath, check.args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
