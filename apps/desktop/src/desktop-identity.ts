// Keep these identifiers stable once the desktop app ships publicly. The
// packaged app id becomes part of the OS credential-store namespace, auto-
// update identity, and installer metadata; changing it later breaks the
// "reinstall/update preserves secrets" guarantee.
export const DESKTOP_APP_ID = "app.uncorded.desktop";
export const DESKTOP_PRODUCT_NAME = "UnCorded";
