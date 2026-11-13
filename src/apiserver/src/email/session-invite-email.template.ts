/**
 * The email a session guest gets when the owner invites them (owner decision D7 = A): a pure function of what the
 * outbox worker reads at send time, answering the subject, an HTML body and a plain-text body, in the welcome
 * email's style (welcome-email.template.ts).
 *
 * Carries the session's title and the owner's name, and nothing of the transcript, the runner, the model, the
 * provider or the repository. The only link is the session's page on this deployment. Every interpolated value is
 * HTML-escaped in the HTML body; no remote images.
 */
import { escapeHtml, hostOf, type RenderedEmail } from './welcome-email.template';

export interface SessionInviteEmailInput {
  /** The owner's name, trimmed, else their email. */
  ownerName: string;
  /** The session's title as stored; its first line is used. */
  sessionTitle: string;
  /** The guest's email: the address the session opens for. */
  guestEmail: string;
  /** This deployment's PUBLIC_ORIGIN, without a trailing slash. */
  origin: string;
  /** The session's id as it is in `/sessions/<id>` URLs (base62). */
  sessionPublicId: string;
}

/** The first line of a session title, or `Untitled session` when it has none (the web's fallback). */
export function inviteTitleOf(title: string | null | undefined): string {
  return (title ?? '').trim().split('\n')[0].trim() || 'Untitled session';
}

/** The owner as the email names them: their name, trimmed, else their email. */
export function ownerNameOf(owner: { name: string | null | undefined; email: string }): string {
  return owner.name?.trim() || owner.email;
}

export function renderSessionInviteEmail(input: SessionInviteEmailInput): RenderedEmail {
  const origin = input.origin.replace(/\/+$/, '');
  const host = hostOf(origin);
  const path = `/sessions/${input.sessionPublicId}`;
  const link = `${origin}${path}`;
  const owner = input.ownerName;
  const title = inviteTitleOf(input.sessionTitle);
  const subject = `${owner} invited you to reply in “${title}”`;
  const body = `${owner} invited you to a conversation on Orbit. You can read it and send messages; they go to ${owner}’s agent and run on ${owner}’s machine.`;
  const signIn = `Sign in as ${input.guestEmail} to open it.`;

  const text = [
    title,
    '',
    body,
    '',
    `Open conversation: ${link}`,
    '',
    signIn,
    '',
  ].join('\n');

  const e = escapeHtml;
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;${font};color:#1f2329">
<tr><td style="padding-bottom:24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><div style="width:16px;height:16px;border:3px solid #1f2329;border-radius:50%"></div></td><td valign="middle" style="padding-left:8px;font-size:20px;font-weight:600">Orbit</td></tr></table></td></tr>
<tr><td style="font-size:26px;font-weight:700;line-height:1.3;padding-bottom:16px">${e(title)}</td></tr>
<tr><td style="font-size:16px;line-height:1.6;padding-bottom:24px">${e(body)}</td></tr>
<tr><td style="padding-bottom:16px"><a href="${e(link)}" style="display:inline-block;background:#1f2329;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px">Open conversation</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#646a73">Or open <a href="${e(link)}" style="color:#1664ff;text-decoration:none">${e(host + path)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#646a73;padding-top:4px">${e(signIn)}</td></tr>
</table>
</td></tr></table>
</body>
</html>
`;

  return { subject, html, text };
}
