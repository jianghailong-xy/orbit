/**
 * The welcome email a new account gets (docs/welcome-email-design.md §3.4): a pure function of what
 * the outbox worker reads at send time, answering the subject, an HTML body and a plain-text body.
 *
 * Never carries a password, a token or a one-time link: the only link is the deployment's own
 * origin. Every interpolated value is HTML-escaped in the HTML body. Inline styles, one
 * 560px column, no remote images (the mark is drawn with CSS borders).
 */

/** How the account signs in, which picks the sign-in line (§3.4 item 2). */
export type WelcomeSignIn =
  | { kind: 'GOOGLE_SIGNUP' }
  | { kind: 'ADMIN_PASSWORD'; admin: string }
  | { kind: 'ADMIN_PASSWORDLESS'; admin: string };

export interface WelcomeEmailInput {
  /** The account's first name: Google's given name, or the part of the email before the @. */
  firstName: string;
  email: string;
  /** This deployment's PUBLIC_ORIGIN, without a trailing slash. */
  origin: string;
  signIn: WelcomeSignIn;
  /** Whether this deployment prepares a managed runner for the account (step 1's two variants). */
  managedRunner: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The host a reader recognises the deployment by: the origin without its scheme. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, '');
  }
}

/** The first name of an account: the first word of its name, else the part of its email before the @. */
export function firstNameOf(name: string | null | undefined, email: string): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first || email.split('@')[0];
}

function signInLine(signIn: WelcomeSignIn): string {
  switch (signIn.kind) {
    case 'GOOGLE_SIGNUP':
      return 'Sign in with Google, using that same address.';
    case 'ADMIN_PASSWORD':
      return `${signIn.admin} added you to Orbit. Sign in with this email address and the password ${signIn.admin} gave you.`;
    case 'ADMIN_PASSWORDLESS':
      return `${signIn.admin} added you to Orbit. Sign in with Google, using this address.`;
  }
}

interface Step {
  title: string;
  body: string;
}

function steps(managedRunner: boolean): Step[] {
  return [
    managedRunner
      ? {
          title: 'Your runner is being prepared',
          body: 'Agents run on a machine of their own. This deployment sets one up for you, so there is nothing to install.',
        }
      : {
          title: 'Connect a computer',
          body: "Install the runner from Settings → Runners. Your agents run there, with that machine's access.",
        },
    {
      title: 'Start your first session',
      body: 'Pick a workspace, describe what you want done, and an agent starts working on it.',
    },
    {
      title: 'Keep an eye on it from anywhere',
      body: 'Turn tasks into tracked work and get notified when an agent needs you.',
    },
  ];
}

export function renderWelcomeEmail(input: WelcomeEmailInput): RenderedEmail {
  const origin = input.origin.replace(/\/+$/, '');
  const host = hostOf(origin);
  const line = signInLine(input.signIn);
  const subject = `Welcome to Orbit, ${input.firstName}`;
  const footer = `You are receiving this one-time email because an account was created for ${input.email} on ${host}. If that wasn't you, reply to this email to reach the administrator.`;

  const text = [
    'Your Orbit account is ready',
    '',
    `Hi ${input.firstName}, an account for ${input.email} is open on ${host}. ${line}`,
    '',
    `Open Orbit: ${origin}`,
    '',
    ...steps(input.managedRunner).flatMap((step, i) => [`${i + 1}. ${step.title}`, `   ${step.body}`]),
    '',
    '--',
    footer,
    '',
  ].join('\n');

  const e = escapeHtml;
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const stepRows = steps(input.managedRunner)
    .map(
      (step, i) => `<tr>
<td valign="top" style="width:28px;padding:${i === 0 ? 0 : 14}px 0 0 0"><div style="width:22px;height:22px;line-height:22px;border-radius:11px;background:#f1f3f5;color:#1f2329;font-size:12px;font-weight:600;text-align:center">${i + 1}</div></td>
<td valign="top" style="padding:${i === 0 ? 0 : 14}px 0 0 8px"><div style="font-size:15px;font-weight:600;color:#1f2329">${e(step.title)}</div><div style="font-size:14px;line-height:1.5;color:#646a73;margin-top:2px">${e(step.body)}</div></td>
</tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;${font};color:#1f2329">
<tr><td style="padding-bottom:24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><div style="width:16px;height:16px;border:3px solid #1f2329;border-radius:50%"></div></td><td valign="middle" style="padding-left:8px;font-size:20px;font-weight:600">Orbit</td></tr></table></td></tr>
<tr><td style="font-size:26px;font-weight:700;line-height:1.3;padding-bottom:16px">Your Orbit account is ready</td></tr>
<tr><td style="font-size:16px;line-height:1.6;padding-bottom:24px">Hi ${e(input.firstName)}, an account for <strong>${e(input.email)}</strong> is open on <a href="${e(origin)}" style="color:#1664ff;text-decoration:none">${e(host)}</a>. ${e(line)}</td></tr>
<tr><td style="padding-bottom:28px"><a href="${e(origin)}" style="display:inline-block;background:#1f2329;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px">Open Orbit</a></td></tr>
<tr><td style="border:1px solid #e4e6e9;border-radius:8px;padding:20px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${stepRows}
</table></td></tr>
<tr><td style="height:28px;border-bottom:1px solid #e4e6e9;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="font-size:12px;line-height:1.6;color:#8f959e;padding-top:16px">${e(footer)}</td></tr>
</table>
</td></tr></table>
</body>
</html>
`;

  return { subject, html, text };
}
