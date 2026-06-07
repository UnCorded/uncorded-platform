// JTI revocation set — tracks revoked JWT token IDs in memory.
// Entries are TTL-pruned after the max token lifetime (10 minutes).

const MAX_TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

export class JtiRevocationSet {
  private revoked = new Map<string, number>(); // jti → timestamp added

  /** Mark a JTI as revoked. */
  add(jti: string): void {
    this.revoked.set(jti, Date.now());
  }

  /** Check if a JTI has been revoked. */
  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  /** Remove entries older than the max token lifetime. Returns count pruned. */
  prune(): number {
    const cutoff = Date.now() - MAX_TOKEN_LIFETIME_MS;
    let pruned = 0;
    for (const [jti, addedAt] of this.revoked) {
      if (addedAt < cutoff) {
        this.revoked.delete(jti);
        pruned++;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.revoked.size;
  }
}
