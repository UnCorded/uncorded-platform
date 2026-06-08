// createPlugin() — factory that initializes the IPC child transport,
// sends the ready handshake, and returns the SDK handle.

import type { IpcRequestMessage, IpcEventDeliverMessage } from "@uncorded/protocol";
import { RuntimeToPluginMessageSchema } from "@uncorded/protocol-schemas";
import { createChildTransport } from "./transport";
import type { IpcMessage } from "./transport";
import { createHandlerRegistry } from "./handle";
import { createRequestClient } from "./request";
import { createEventsApi } from "./events";
import { createPermissionsApi } from "./permissions";
import { createResourcesApi } from "./resources";
import { createDataApi } from "./data";
import { createDbApi } from "./db";
import { createCoreApi } from "./core";
import { createKvApi } from "./kv";
import { createSettingsApi } from "./settings";
import { createFetchApi } from "./fetch";
import { createScheduleApi } from "./schedule";
import { createPresenceApi } from "./presence";
import { createBroadcastApi } from "./broadcast";
import { createVoiceApi } from "./voice";
import { createFilesApi } from "./files";
import type { PluginHandle } from "./types";

// ---------------------------------------------------------------------------
// File upload notification type
// ---------------------------------------------------------------------------

/** Notification sent from the runtime when a file upload completes for this plugin. */
export interface FileUploadedMessage extends IpcMessage {
  type: "file.uploaded";
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  uploadedBy: string;
  uploadedAt: number;
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface PluginOptions {
  /** Called when the runtime delivers a file.uploaded notification to this plugin. */
  onFileUploaded?: ((msg: FileUploadedMessage) => void) | undefined;
}

/**
 * Initialize the plugin SDK. Call this once at plugin startup.
 *
 * - Creates the stdio IPC transport
 * - Wires up message dispatch
 * - Sends the `{ type: "ready" }` handshake to the runtime
 * - Returns the SDK handle
 */
export function createPlugin(options?: PluginOptions): PluginHandle {
  const transport = createChildTransport();
  const handlers = createHandlerRegistry(transport);
  const client = createRequestClient(transport);
  const events = createEventsApi(transport, client);
  const permissions = createPermissionsApi(client);
  const resources = createResourcesApi(client);
  const data = createDataApi(client);
  const db = createDbApi(client);
  const core = createCoreApi(client);
  const kv = createKvApi(client);
  const settings = createSettingsApi(client);
  const fetchApi = createFetchApi(client);
  const schedule = createScheduleApi(client, handlers.register);
  const presence = createPresenceApi({ events, client });
  const broadcast = createBroadcastApi(client);
  const voice = createVoiceApi(client);
  const files = createFilesApi(client);

  // Central message dispatcher.
  //
  // The runtime-to-plugin message set is a tight discriminated union — anything
  // outside it is dropped silently (matches prior behavior). For known types we
  // safeParse first so a malformed frame from a buggy or compromised runtime
  // never reaches a handler with `as`-cast nonsense in it.
  transport.onMessage((msg: IpcMessage) => {
    const parsed = RuntimeToPluginMessageSchema.safeParse(msg);
    if (!parsed.success) {
      // Unknown / malformed: silently drop. We can't log to stderr from here
      // without polluting the runtime's log stream — and the dispatcher
      // already had "unknown types are silently ignored" as documented behavior.
      return;
    }
    const validated = parsed.data;
    switch (validated.type) {
      case "request":
        handlers.dispatch(validated as IpcRequestMessage);
        break;

      case "response":
      case "event.ack":
        client.handleResponse(validated);
        break;

      case "event.deliver":
        // Access handleDelivery from the events object (attached via Object.assign)
        (events as unknown as { handleDelivery(msg: IpcEventDeliverMessage): void })
          .handleDelivery(validated as IpcEventDeliverMessage);
        break;

      case "ping":
        // Watchdog heartbeat — auto-respond with pong
        transport.send({ type: "pong" });
        break;

      case "file.uploaded":
        if (options?.onFileUploaded) {
          options.onFileUploaded(validated as FileUploadedMessage);
        }
        break;

      case "core.plugin.config_changed":
        settings.handleChange({ key: validated.key, value: validated.value });
        break;
    }
  });

  // Signal to the runtime that the plugin is ready
  transport.send({ type: "ready" });

  return {
    handle: handlers.register,
    request: client.request,
    events: {
      publish: events.publish,
      subscribe: events.subscribe,
      unsubscribe: events.unsubscribe,
    },
    permissions,
    resources,
    data,
    db,
    core,
    kv,
    settings,
    fetch: fetchApi.fetch.bind(fetchApi),
    broadcast,
    schedule,
    presence,
    voice,
    files,
    serveReady() {
      transport.send({ type: "serve_ready" });
    },
  };
}
