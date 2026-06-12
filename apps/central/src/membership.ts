// Membership quotas — Phase 1 limits (spec: membership & invites).
//
// Owned counts every server with owner_id = you, including ones mid-delete:
// the owned slot frees only on confirmed purge so a delete-recreate loop
// can't mint unlimited servers. Joined counts active non-owner memberships
// and is enforced where a membership is created (invite accept / join-request
// accept). The invite cap counts *pending* invitations per server.

export const MAX_OWNED_SERVERS = 5;
export const MAX_JOINED_SERVERS = 15;
export const MAX_ACTIVE_INVITES_PER_SERVER = 20;
