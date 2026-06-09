// Pure presentation helpers for reverse-proxy mount status, kept out of the
// SolidJS component so they can be unit-tested without a DOM/render harness.

import type { ProxyMountApprovalStatus, ProxyMountWarning } from "@/lib/admin-plugins";

/** Human-readable label for a mount's approval status. */
export function proxyStatusLabel(status: ProxyMountApprovalStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "pending":
      return "Pending approval";
    case "drifted":
      return "Needs re-approval";
    case "invalid":
      return "Invalid upstream";
  }
}

/** Tailwind badge classes for a mount's approval status. */
export function proxyStatusBadgeClass(status: ProxyMountApprovalStatus): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "pending":
    case "drifted":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "invalid":
      return "bg-destructive/15 text-destructive";
  }
}

/** Human-readable explanation of a local/private upstream advisory. */
export function proxyWarningText(warning: ProxyMountWarning): string {
  switch (warning) {
    case "loopback":
      return "Loopback target — only reachable from the server host itself.";
    case "docker-internal":
      return "Docker host alias — resolves to the machine running the container.";
    case "rfc1918":
      return "Private network address (RFC 1918) — only reachable on the local network.";
    case "link-local":
      return "Link-local address — only reachable on the local network segment.";
    case "unique-local":
      return "Unique-local IPv6 address — only reachable on the local network.";
    case "cgnat":
      return "Carrier-grade NAT address — typically a private/shared network range.";
    case "mdns":
      return "mDNS/.local name — resolved only on the local network.";
  }
}
