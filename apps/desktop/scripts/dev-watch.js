const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const appRoot = path.resolve(__dirname, "..");
const tscBin = require.resolve("typescript/lib/tsc.js");
const electronCli = require.resolve("electron/cli.js");

let tscProc = null;
let electronProc = null;
let restartPending = false;
let shuttingDown = false;

function logPrefix(prefix, line) {
  const trimmed = line.replace(/\r?\n$/, "");
  if (trimmed.length > 0) {
    process.stdout.write(`[${prefix}] ${trimmed}\n`);
  }
}

function startElectron() {
  if (shuttingDown || electronProc) return;

  const child = spawn(process.execPath, [electronCli, "."], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
    stdio: "inherit",
  });

  electronProc = child;

  child.on("exit", (code, signal) => {
    electronProc = null;

    if (shuttingDown) {
      return;
    }

    if (restartPending) {
      restartPending = false;
      startElectron();
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    if (code === 0 || signal === "SIGTERM") {
      console.log(`[dev-watch] Electron exited (${reason}).`);
    } else {
      console.error(`[dev-watch] Electron exited unexpectedly (${reason}).`);
    }
    shutdown();
  });
}

function restartElectron() {
  if (!electronProc) {
    startElectron();
    return;
  }

  restartPending = true;
  electronProc.kill("SIGTERM");
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electronProc) {
    electronProc.kill("SIGTERM");
  }
  if (tscProc) {
    tscProc.kill("SIGTERM");
  }
}

function main() {
  const child = spawn(process.execPath, [tscBin, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], {
    cwd: appRoot,
    stdio: ["inherit", "pipe", "pipe"],
  });

  tscProc = child;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    logPrefix("tsc", line);
    if (line.includes("Found 0 errors. Watching for file changes.")) {
      if (!electronProc) {
        startElectron();
      } else {
        restartElectron();
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    tscProc = null;
    rl.close();
    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      console.error(`[dev-watch] TypeScript watcher exited (${reason}).`);
      shutdown();
      process.exit(code ?? 1);
    }
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[dev-watch] TypeScript watcher started.");
}

main();
