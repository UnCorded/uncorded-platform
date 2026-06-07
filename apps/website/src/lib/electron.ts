// The desktop preload script injects window.electron when running inside Electron.
// Gate all access through these helpers so browser builds never call undefined methods.

export function isElectron(): boolean {
  return typeof window !== "undefined" && "electron" in window;
}

export function getElectron(): Window["electron"] {
  if (!isElectron()) {
    throw new Error("Not running in Electron");
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return window.electron;
}
