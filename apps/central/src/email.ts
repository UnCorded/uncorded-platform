import { Resend } from "resend";

export function createEmailClient(): Resend | null {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return null;
  return new Resend(key);
}

export function getFromAddress(): string {
  return process.env["RESEND_FROM_EMAIL"] ?? "noreply@uncorded.app";
}

export async function sendVerificationEmail(
  client: Resend,
  to: string,
  verificationUrl: string,
): Promise<void> {
  await client.emails.send({
    from: getFromAddress(),
    to,
    subject: "Verify your UnCorded account",
    html: `
      <p>Thanks for creating an UnCorded account.</p>
      <p><a href="${verificationUrl}">Click here to verify your email address.</a></p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `,
    text: `Verify your UnCorded account:\n\n${verificationUrl}\n\nThis link expires in 24 hours.`,
  });
}

export interface TransferEmailContext {
  serverName: string;
  recipientDisplayName: string;
  ownerDisplayName: string;
  confirmUrl: string;
  declineUrl: string;
  expiresAt: Date;
}

export async function sendTransferInitiatedToOwner(
  client: Resend,
  to: string,
  ctx: TransferEmailContext,
): Promise<void> {
  await client.emails.send({
    from: getFromAddress(),
    to,
    subject: `Confirm transfer of ${ctx.serverName}`,
    html: `
      <p>You started a transfer of <strong>${ctx.serverName}</strong> to ${ctx.recipientDisplayName}.</p>
      <p>Both parties must confirm before ownership moves.</p>
      <p><a href="${ctx.confirmUrl}">Confirm the transfer</a></p>
      <p>If this wasn't you, <a href="${ctx.declineUrl}">cancel it now</a>.</p>
      <p>This link expires at ${ctx.expiresAt.toUTCString()}.</p>
    `,
    text:
      `You started a transfer of ${ctx.serverName} to ${ctx.recipientDisplayName}.\n\n` +
      `Confirm: ${ctx.confirmUrl}\n` +
      `Cancel:  ${ctx.declineUrl}\n\n` +
      `Both parties must confirm before ownership moves. Link expires at ${ctx.expiresAt.toUTCString()}.`,
  });
}

export async function sendTransferInitiatedToRecipient(
  client: Resend,
  to: string,
  ctx: TransferEmailContext,
): Promise<void> {
  await client.emails.send({
    from: getFromAddress(),
    to,
    subject: `${ctx.ownerDisplayName} wants to transfer ${ctx.serverName} to you`,
    html: `
      <p><strong>${ctx.ownerDisplayName}</strong> has offered to transfer ownership of <strong>${ctx.serverName}</strong> to your account.</p>
      <p>If you accept, you become the owner — billing, server settings, and the ability to delete the server all move to you.</p>
      <p><a href="${ctx.confirmUrl}">Accept the transfer</a></p>
      <p>Not interested? <a href="${ctx.declineUrl}">Decline</a>.</p>
      <p>This link expires at ${ctx.expiresAt.toUTCString()}.</p>
    `,
    text:
      `${ctx.ownerDisplayName} has offered to transfer ownership of ${ctx.serverName} to your account.\n\n` +
      `Accept:  ${ctx.confirmUrl}\n` +
      `Decline: ${ctx.declineUrl}\n\n` +
      `Both parties must confirm before ownership moves. Link expires at ${ctx.expiresAt.toUTCString()}.`,
  });
}
