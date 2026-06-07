import type { Sql } from "./db";
import type { RateLimiter } from "./middleware";
import type { Logger } from "@uncorded/shared";
import { notFound, internalError } from "./errors";
import { handleHealth, type BootInfo } from "./routes/health";
import { handleRegister } from "./routes/register";
import { handleLogin } from "./routes/login";
import { handleLogout } from "./routes/logout";
import { handleGetProfile, handlePatchProfile } from "./routes/profile";
import { handleServerToken } from "./routes/server-token";
import {
  handleCreateServer,
  handleListServers,
  handleGetServer,
  handleUpdateServer,
  handleDeleteServer,
} from "./routes/servers";
import { handleHeartbeat } from "./routes/heartbeat";
import { handleVoiceProbe } from "./routes/voice-probe";
import { handleTokenRefresh } from "./routes/token-refresh";
import { handleRotateSecret } from "./routes/server-rotate";
import {
  handleTransferServer,
  handleConfirmServerTransfer,
  handleDeclineServerTransfer,
} from "./routes/server-transfer";
import {
  handleOAuthRedirect,
  handleOAuthCallback,
  handleDesktopOAuthExchange,
  handleOAuthLinkStart,
  handleOAuthUnlink,
} from "./routes/oauth";
import { handleVerifyEmail } from "./routes/verify-email";
import { handleResendVerification } from "./routes/resend-verification";
import { handleListPlugins, handleGetPlugin } from "./routes/plugins";
import { handlePluginReport } from "./routes/plugin-report";
import { handlePublishPlugin } from "./routes/publish-plugin";
import { handlePublishVersion } from "./routes/publish-version";
import { handleDownloadPlugin } from "./routes/download-plugin";
import { handleAvatarUploadUrl } from "./routes/avatar-upload";
import { handleListReports, handleResolveReport } from "./routes/admin-reports";
import { handleCheckFrame } from "./routes/check-frame";

export interface RouteContext {
  readonly sql: Sql;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly emailClient: import("resend").Resend | null;
  readonly appBaseUrl: string;
  readonly r2: import("./r2").R2Client | null;
  readonly bootInfo: BootInfo;
}

const ALLOWED_ORIGINS = new Set([
  "https://uncorded.app",
  "https://www.uncorded.app",
  "http://localhost:5174",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return allowed ? {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  } : {};
}

export function createRouter(ctx: RouteContext) {
  return async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const origin = request.headers.get("origin");

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      const response = await (async () => {
      // Health check
      if (pathname === "/health" && method === "GET") {
        return await handleHealth(ctx.sql, ctx.bootInfo);
      }

      // Auth routes
      if (pathname === "/v1/auth/register" && method === "POST") {
        return await handleRegister(request, ctx);
      }
      if (pathname === "/v1/auth/login" && method === "POST") {
        return await handleLogin(request, ctx);
      }
      if (pathname === "/v1/auth/logout" && method === "POST") {
        return await handleLogout(request, ctx);
      }
      if (pathname === "/v1/auth/profile" && method === "GET") {
        return await handleGetProfile(request, ctx);
      }
      if (pathname === "/v1/auth/profile" && method === "PATCH") {
        return await handlePatchProfile(request, ctx);
      }
      if (pathname === "/v1/auth/token/server" && method === "POST") {
        return await handleServerToken(request, ctx);
      }
      if (pathname === "/v1/auth/token/refresh" && method === "POST") {
        return await handleTokenRefresh(request, ctx);
      }
      if (pathname === "/v1/auth/verify-email" && method === "GET") {
        return await handleVerifyEmail(request, ctx);
      }
      if (pathname === "/v1/auth/resend-verification" && method === "POST") {
        return await handleResendVerification(request, ctx);
      }
      if (pathname === "/v1/auth/avatar/upload-url" && method === "POST") {
        return await handleAvatarUploadUrl(request, ctx);
      }

      // OAuth provider routes
      if (pathname === "/v1/auth/google" && method === "GET") {
        return handleOAuthRedirect("google", request);
      }
      if (pathname === "/v1/auth/google/callback" && method === "GET") {
        return await handleOAuthCallback("google", request, ctx);
      }
      if (pathname === "/v1/auth/discord" && method === "GET") {
        return handleOAuthRedirect("discord", request);
      }
      if (pathname === "/v1/auth/discord/callback" && method === "GET") {
        return await handleOAuthCallback("discord", request, ctx);
      }
      if (pathname === "/v1/auth/github" && method === "GET") {
        return handleOAuthRedirect("github", request);
      }
      if (pathname === "/v1/auth/github/callback" && method === "GET") {
        return await handleOAuthCallback("github", request, ctx);
      }
      if (pathname === "/v1/auth/desktop-oauth/exchange" && method === "POST") {
        return await handleDesktopOAuthExchange(request, ctx);
      }

      // OAuth link/unlink
      const linkMatch = pathname.match(/^\/v1\/auth\/link\/(\w+)$/);
      if (linkMatch && method === "GET") {
        return await handleOAuthLinkStart(
          linkMatch[1] as "google" | "discord" | "github",
          request,
          ctx,
        );
      }
      const unlinkMatch = pathname.match(/^\/v1\/auth\/providers\/(\w+)$/);
      if (unlinkMatch && method === "DELETE") {
        return await handleOAuthUnlink(unlinkMatch[1]!, request, ctx);
      }

      // Server directory (exact path)
      if (pathname === "/v1/servers" && method === "POST") {
        return await handleCreateServer(request, ctx);
      }
      if (pathname === "/v1/servers" && method === "GET") {
        return await handleListServers(request, ctx);
      }

      // Parameterized server routes
      const serverIdMatch = pathname.match(
        /^\/v1\/servers\/([0-9a-f-]{36})$/,
      );
      if (serverIdMatch) {
        const serverId = serverIdMatch[1]!;
        if (method === "GET")
          return await handleGetServer(request, ctx, serverId);
        if (method === "PATCH")
          return await handleUpdateServer(request, ctx, serverId);
        if (method === "DELETE")
          return await handleDeleteServer(request, ctx, serverId);
      }

      // Heartbeat
      const heartbeatMatch = pathname.match(
        /^\/v1\/servers\/([0-9a-f-]{36})\/heartbeat$/,
      );
      if (heartbeatMatch && method === "POST") {
        return await handleHeartbeat(request, ctx, heartbeatMatch[1]!);
      }

      // Voice external-reachability probe (spec-24 Amendment A2)
      const voiceProbeMatch = pathname.match(
        /^\/v1\/servers\/([0-9a-f-]{36})\/voice\/probe$/,
      );
      if (voiceProbeMatch && method === "POST") {
        return await handleVoiceProbe(request, ctx, voiceProbeMatch[1]!);
      }

      // Secret rotation
      const rotateMatch = pathname.match(
        /^\/v1\/servers\/([0-9a-f-]{36})\/secret\/rotate$/,
      );
      if (rotateMatch && method === "POST") {
        return await handleRotateSecret(request, ctx, rotateMatch[1]!);
      }

      // Ownership transfer
      const transferMatch = pathname.match(
        /^\/v1\/servers\/([0-9a-f-]{36})\/transfer$/,
      );
      if (transferMatch && method === "POST") {
        return await handleTransferServer(request, ctx, transferMatch[1]!);
      }

      // Two-sided transfer confirm/decline (token-bearer; unauthenticated)
      const transferConfirmMatch = pathname.match(
        /^\/v1\/server-transfers\/([0-9a-f-]{36})\/confirm$/,
      );
      if (transferConfirmMatch && method === "POST") {
        return await handleConfirmServerTransfer(request, ctx, transferConfirmMatch[1]!);
      }
      const transferDeclineMatch = pathname.match(
        /^\/v1\/server-transfers\/([0-9a-f-]{36})\/decline$/,
      );
      if (transferDeclineMatch && method === "POST") {
        return await handleDeclineServerTransfer(request, ctx, transferDeclineMatch[1]!);
      }

      // Marketplace — sub-resource routes must be matched before the generic slug route
      const pluginReportMatch = pathname.match(/^\/v1\/plugins\/([a-z0-9-]+)\/report$/);
      if (pluginReportMatch && method === "POST") {
        return await handlePluginReport(request, ctx, pluginReportMatch[1]!);
      }

      const pluginDownloadMatch = pathname.match(/^\/v1\/plugins\/([a-z0-9-]+)\/download$/);
      if (pluginDownloadMatch && method === "GET") {
        return await handleDownloadPlugin(request, ctx, pluginDownloadMatch[1]!);
      }

      const pluginVersionsMatch = pathname.match(/^\/v1\/plugins\/([a-z0-9-]+)\/versions$/);
      if (pluginVersionsMatch && method === "POST") {
        return await handlePublishVersion(request, ctx, pluginVersionsMatch[1]!);
      }

      if (pathname === "/v1/plugins" && method === "GET") {
        return await handleListPlugins(request, ctx);
      }

      if (pathname === "/v1/plugins" && method === "POST") {
        return await handlePublishPlugin(request, ctx);
      }

      const pluginSlugMatch = pathname.match(/^\/v1\/plugins\/([a-z0-9-]+)$/);
      if (pluginSlugMatch && method === "GET") {
        return await handleGetPlugin(request, ctx, pluginSlugMatch[1]!);
      }

      // Frame policy probe (session-gated; see route handler)
      if (pathname === "/v1/check-frame" && method === "GET") {
        return await handleCheckFrame(request, ctx);
      }

      // Admin
      if (pathname === "/v1/reports" && method === "GET") {
        return await handleListReports(request, ctx);
      }

      const reportIdMatch = pathname.match(/^\/v1\/reports\/([0-9a-f-]{36})$/);
      if (reportIdMatch && method === "PATCH") {
        return await handleResolveReport(request, ctx, reportIdMatch[1]!);
      }

        return notFound("Route not found");
      })();
      return addCors(response, origin);
    } catch (err) {
      ctx.logger.error("unhandled route error", {
        err: err instanceof Error ? err.message : String(err),
        pathname,
      });
      return addCors(internalError(), origin);
    }
  };
}

function addCors(response: Response, origin: string | null): Response {
  const headers = corsHeaders(origin);
  if (Object.keys(headers).length === 0) return response;
  const next = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) next.headers.set(k, v);
  return next;
}
