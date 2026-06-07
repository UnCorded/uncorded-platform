export function getAdminEmails(): Set<string> {
  const raw = process.env["ADMIN_EMAILS"] ?? "";
  return new Set(raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export function isAdmin(email: string): boolean {
  return getAdminEmails().has(email.toLowerCase());
}
