const state = {
  token: null,
  bootstrap: null,
  plugins: [],
  activeTab: "roles",
  trustedParentOrigin: null,
};

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function showTab(tab) {
  state.activeTab = tab;
  const sections = document.querySelectorAll(".tab");
  sections.forEach((section) => {
    section.classList.toggle("hidden", section.id !== `tab-${tab}`);
  });
}

function clearNode(node) {
  node.replaceChildren();
}

async function api(path, init = {}) {
  if (!state.token) throw new Error("Missing admin token");
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${state.token}`,
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`/admin/api/${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      message = body.error?.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json();
}

function wireTabs() {
  document.querySelectorAll("#tabs button").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
}

async function loadRoles() {
  const data = await api("roles");
  const root = document.getElementById("roles-list");
  clearNode(root);

  data.roles.forEach((role) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("strong");
    title.textContent = role.name;
    card.appendChild(title);
    card.appendChild(document.createTextNode(` (level ${String(role.level)})`));
    if (role.isDefault) {
      const defaultBadge = document.createElement("span");
      defaultBadge.className = "muted";
      defaultBadge.textContent = " default";
      card.appendChild(defaultBadge);
    }

    const row = document.createElement("div");
    row.className = "row";

    const nameInput = document.createElement("input");
    nameInput.value = role.name;
    row.appendChild(nameInput);

    const levelInput = document.createElement("input");
    levelInput.type = "number";
    levelInput.min = "1";
    levelInput.max = "99";
    levelInput.value = String(role.level);
    row.appendChild(levelInput);

    const saveButton = document.createElement("button");
    saveButton.textContent = "Save";
    row.appendChild(saveButton);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.disabled = Boolean(role.isDefault);
    row.appendChild(deleteButton);

    card.appendChild(row);

    const perms = document.createElement("p");
    perms.className = "muted";
    perms.textContent = `Permission overrides: ${String(Object.keys(role.permissions || {}).length)}`;
    card.appendChild(perms);

    saveButton.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const level = Number(levelInput.value);
      await api(`roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, level }),
      });
      await loadRoles();
      await loadAudit();
    });

    deleteButton.addEventListener("click", async () => {
      await api(`roles/${role.id}`, { method: "DELETE" });
      await loadRoles();
      await loadAudit();
    });

    root.appendChild(card);
  });
}

async function loadPlugins() {
  const data = await api("plugins");
  state.plugins = data.plugins;

  const root = document.getElementById("plugins-list");
  const logSelect = document.getElementById("logs-plugin");
  const termSelect = document.getElementById("terminal-plugin");
  clearNode(root);
  clearNode(logSelect);
  clearNode(termSelect);

  data.plugins.forEach((plugin) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("strong");
    title.textContent = plugin.slug;
    card.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "muted";
    desc.textContent = plugin.manifest.description || "";
    card.appendChild(desc);

    const row = document.createElement("div");
    row.className = "row";

    const status = document.createElement("span");
    status.textContent = `status: ${plugin.statusLabel}${plugin.state ? ` (${plugin.state})` : ""}`;
    row.appendChild(status);

    const label = document.createElement("label");
    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = Boolean(plugin.enabled);
    label.appendChild(enabledToggle);
    label.appendChild(document.createTextNode(" enabled"));
    row.appendChild(label);

    card.appendChild(row);

    enabledToggle.addEventListener("change", async (event) => {
      await api(`plugins/${plugin.slug}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: event.target.checked }),
      });
      await loadPlugins();
      await loadAudit();
    });
    root.appendChild(card);

    const optionA = document.createElement("option");
    optionA.value = plugin.slug;
    optionA.textContent = plugin.slug;
    logSelect.appendChild(optionA);

    const optionB = document.createElement("option");
    optionB.value = plugin.slug;
    optionB.textContent = plugin.slug;
    termSelect.appendChild(optionB);
  });
}

async function loadLogs() {
  const slug = document.getElementById("logs-plugin").value;
  if (!slug) return;
  const data = await api(`plugins/${slug}/logs?limit=300`);
  const lines = data.logs.map((entry) =>
    `[${new Date(entry.ts).toISOString()}] ${entry.stream}: ${entry.line}`,
  );
  document.getElementById("plugin-logs").textContent = lines.join("\n");
}

async function loadAudit() {
  const data = await api("audit?limit=200");
  const root = document.getElementById("audit-list");
  clearNode(root);

  data.events.forEach((event) => {
    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    const action = document.createElement("strong");
    action.textContent = event.action;
    const id = document.createElement("span");
    id.className = "muted";
    id.textContent = ` #${String(event.id)}`;
    header.appendChild(action);
    header.appendChild(id);
    card.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `${new Date(event.ts).toLocaleString()} · actor ${event.actorUserId} (${event.actorRole})`;
    card.appendChild(meta);

    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(event.payload, null, 2);
    card.appendChild(payload);

    root.appendChild(card);
  });
}

async function loadCascade() {
  const data = await api("cascade");
  const root = document.getElementById("cascade-list");
  clearNode(root);

  data.rules.forEach((rule) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("div");
    const source = document.createElement("strong");
    source.textContent = rule.sourcePlugin;
    title.appendChild(source);
    title.appendChild(document.createTextNode(` -> ${rule.targetPlugin}`));
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `${rule.eventTopic} · ${rule.targetAction} · enabled=${String(rule.enabled)}`;
    card.appendChild(meta);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", async () => {
      await api(`cascade/${rule.id}`, { method: "DELETE" });
      await loadCascade();
      await loadAudit();
    });
    card.appendChild(deleteButton);

    root.appendChild(card);
  });
}

function wireForms() {
  document.getElementById("role-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("roles", {
      method: "POST",
      body: JSON.stringify({
        name: String(form.get("name") || "").trim(),
        level: Number(form.get("level")),
      }),
    });
    event.currentTarget.reset();
    await loadRoles();
    await loadAudit();
  });

  document.getElementById("logs-refresh").addEventListener("click", () => { void loadLogs(); });
  document.getElementById("audit-refresh").addEventListener("click", () => { void loadAudit(); });

  document.getElementById("icon-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("icon-status");
    const fileInput = document.getElementById("icon-file");
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("icon", file);
    try {
      const res = await fetch("/admin/api/icon", {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json();
        status.textContent = `Error: ${body.error?.message || String(res.status)}`;
        return;
      }
      status.textContent = "Icon updated!";
      const img = document.getElementById("current-icon");
      img.src = `/icon?t=${Date.now()}`;
      event.currentTarget.reset();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  document.getElementById("cascade-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("cascade", {
      method: "POST",
      body: JSON.stringify({
        sourcePlugin: String(form.get("sourcePlugin") || "").trim(),
        eventTopic: String(form.get("eventTopic") || "").trim(),
        targetPlugin: String(form.get("targetPlugin") || "").trim(),
        targetAction: String(form.get("targetAction") || "").trim(),
        enabled: form.get("enabled") === "on",
      }),
    });
    event.currentTarget.reset();
    await loadCascade();
    await loadAudit();
  });

}

async function bootstrapAdmin() {
  const data = await api("bootstrap");
  state.bootstrap = data;
  if (!data.adminAccess) {
    throw new Error("User is not authorized for admin panel.");
  }
  setStatus(`Authenticated as ${data.user.id} (${data.user.role})`);
}

async function loadAll() {
  await bootstrapAdmin();
  await loadRoles();
  await loadPlugins();
  await loadLogs();
  await loadAudit();
  await loadCascade();
}

function isAllowedParentOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();
  if ((host === "localhost" || host === "127.0.0.1") && (protocol === "http:" || protocol === "https:")) {
    return true;
  }
  return protocol === "https:" && (host === "uncorded.app" || host.endsWith(".uncorded.app"));
}

function getTrustedParentOrigin() {
  if (!document.referrer) {
    console.warn("Admin panel loaded without a referrer; falling back to wildcard postMessage target.");
    return null;
  }

  if (!isAllowedParentOrigin(document.referrer)) {
    console.warn("Admin panel referrer is not an allowed shell origin; falling back to wildcard postMessage target.", {
      referrer: document.referrer,
    });
    return null;
  }

  return new URL(document.referrer).origin;
}

function onMessage(event) {
  if (!event.data || typeof event.data !== "object") return;
  if (event.source !== window.parent) return;
  if (state.trustedParentOrigin !== null && event.origin !== state.trustedParentOrigin) return;

  if (event.data.type === "uncorded.token" && typeof event.data.token === "string") {
    state.token = event.data.token;
    setStatus("Token received. Loading admin data...");
    void loadAll().catch((error) => {
      setStatus(`Error: ${error.message}`);
    });
  }
}

function init() {
  wireTabs();
  wireForms();
  showTab("roles");
  state.trustedParentOrigin = getTrustedParentOrigin();
  window.addEventListener("message", onMessage);
  if (state.trustedParentOrigin) {
    window.parent.postMessage(
      { type: "uncorded.ready" },
      state.trustedParentOrigin,
    );
  } else {
    console.warn("Admin panel: no trusted parent origin — skipping uncorded.ready postMessage.");
  }
}

init();
