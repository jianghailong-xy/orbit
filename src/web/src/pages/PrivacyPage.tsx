import { useEffect } from 'react';

/** Where the policy sends every request about one's data. */
const PRIVACY_EMAIL = 'privacy@orbitd.io';

/**
 * The privacy policy, at /privacy: the page Google's consent screen links to as the app's privacy
 * policy (docs/google-sign-in-design.md §5.6, §7.2), and the login page's Privacy link. It is public —
 * the same page signed out or in, outside the auth gate and the app shell, and BootGate lets it through
 * without the splash — so nothing stands between whoever opens it and the text. The words are the
 * owner's, as of the date it gives, and are kept exactly as written: a change to them is a new
 * revision with a new date.
 */
export function PrivacyPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = 'Privacy Policy — Orbit';
    return () => {
      document.title = prev;
    };
  }, []);

  const email = <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>;
  return (
    <main className="privacy-page">
      <article className="privacy-doc">
        <h1>Privacy Policy</h1>
        <p className="privacy-updated">Last updated: October 25, 2026</p>
        <p>
          Orbit is a service for running and managing AI coding agents. This policy explains what personal data we
          collect, why we collect it, and the choices you have.
        </p>

        <h2>What we collect</h2>
        <ul>
          <li>
            Account details: your email address and, if you sign in with Google, the name, email address and profile
            picture Google shares with us. If you sign in with a password, we store only a password hash.
          </li>
          <li>Your content: workspaces, sessions, tasks, messages and files you create or upload.</li>
          <li>
            Technical data: IP address, browser and device type, and the logs we need to run and secure the service.
          </li>
          <li>
            Session data: access and refresh tokens. Refresh tokens are stored hashed; credentials for external model
            providers are stored encrypted.
          </li>
        </ul>

        <h2>How we use it</h2>
        <p>
          To provide the service, sign you in, keep your workspaces private to your account, send service notices,
          prevent abuse, and fix problems.
        </p>

        <h2>Sharing</h2>
        <p>
          We do not sell personal data. We share data only with providers needed to run the service: the AI model
          engines you connect, and Google when you choose to sign in with Google. Google sign-in requests only your
          basic profile and email address; we never receive your Google password.
        </p>

        <h2>Cookies and local storage</h2>
        <p>
          We use cookies and local storage to keep you signed in and to remember interface settings. We do not use
          advertising cookies.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          We keep your data while your account is active. You can delete content in the product. Deleting your account
          removes its data, except records we must keep by law and backups kept for a limited period.
        </p>

        <h2>Your choices</h2>
        <p>
          You can ask for a copy of your data, correct it, or delete your account by writing to {email}. If you signed
          in with Google, you can also revoke Orbit's access from your Google Account page.
        </p>

        <h2>Changes</h2>
        <p>
          We may update this policy. The date above is the latest revision; material changes will be announced on
          this page.
        </p>

        <h2>Contact</h2>
        <p>{email}</p>
      </article>
    </main>
  );
}
