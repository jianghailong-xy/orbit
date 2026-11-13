import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiOutlined, LeftOutlined, LoginOutlined, MailOutlined, TeamOutlined } from '@ant-design/icons';
import { api } from '../../api';
import { settingsReturnPath } from '../../lib/settingsReturn';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { feishuAdminQuery } from '../../pages/AdminIntegrationsPage';
import { googleSignInSettingsQuery } from '../../pages/AdminSignInPage';
import { emailSettingsQuery } from '../../pages/AdminEmailPage';
import { ImpersonationBanner } from '../ImpersonationBanner';
import { NARROW_SETTINGS_QUERY, NavGroup, NavRow } from './SettingsLayout';
import './Settings.css';

/** A row's On / Off, drawn as the Machines group draws a machine's state. */
function OnDot({ on }: { on: boolean | undefined }) {
  if (on === undefined) return null;
  return (
    <span
      className={`settings-dot settings-dot--${on ? 'online' : 'offline'}`}
      role="img"
      aria-label={on ? 'On' : 'Off'}
      title={on ? 'On' : 'Off'}
    />
  );
}

/** What "‹ Admin" opens /admin with, in a narrow window: the nav as a page of its own, not Users. */
export const ADMIN_NAV_STATE = { adminNav: true } as const;

/**
 * The Admin window, drawn as Settings is (owner's choice A, docs/mocks/admin-settings-style): it takes over the
 * window, a nav of its pages on the left, the chosen page in a centred column on the right, "Back to Orbit" and
 * Esc to go back to the page Admin was opened from. Narrower than Settings' 760px the two stop sitting side by
 * side: a page opens full width with "‹ Admin" above it, which opens the nav as a page of its own.
 */
export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const narrow = useMediaQuery(NARROW_SETTINGS_QUERY);
  const atList = narrow && (location.state as { adminNav?: boolean } | null)?.adminNav === true;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Something drawn over the page (a dialog, an open menu) takes the key.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')) return;
      navigate(settingsReturnPath());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <>
      <ImpersonationBanner />
      <div className={narrow ? 'settings-shell settings-shell--narrow' : 'settings-shell'}>
        {(!narrow || atList) && <AdminNav />}
        {(!narrow || !atList) && (
          <main className="settings-main">
            <div className="settings-column">
              {narrow && (
                <button type="button" className="settings-back settings-back--list" onClick={() => navigate('/admin', { state: ADMIN_NAV_STATE })}>
                  <LeftOutlined />
                  <span>Admin</span>
                </button>
              )}
              <Outlet />
            </div>
          </main>
        )}
      </div>
    </>
  );
}

function AdminNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Array<{ id: string }>>('/admin/users') });
  const google = useQuery(googleSignInSettingsQuery());
  const email = useQuery(emailSettingsQuery());
  const feishu = useQuery(feishuAdminQuery());
  const googleOn = google.data
    ? google.data.enabled && google.data.clientId !== '' && google.data.hasSecret && !google.data.secretUnreadable
    : undefined;
  return (
    <nav className="settings-nav autohide-scrollbar" aria-label="Admin">
      <button type="button" className="settings-back" onClick={() => navigate(settingsReturnPath())}>
        <LeftOutlined />
        <span>Back to Orbit</span>
      </button>
      <h1 className="settings-title">Admin</h1>
      <div className="settings-nav-groups">
        <NavGroup title="Accounts">
          <NavRow
            to="/admin"
            icon={<TeamOutlined />}
            label="Users"
            active={/^\/admin\/?$/.test(pathname)}
            trailing={users.data ? <span className="settings-nav-meta">{users.data.length}</span> : undefined}
          />
          <NavRow to="/admin/sign-in" icon={<LoginOutlined />} label="Sign-in" trailing={<OnDot on={googleOn} />} />
        </NavGroup>
        <NavGroup title="Server">
          <NavRow to="/admin/email" icon={<MailOutlined />} label="Email" trailing={<OnDot on={email.data?.on} />} />
        </NavGroup>
        <NavGroup title="Integrations">
          <NavRow to="/admin/integrations" icon={<ApiOutlined />} label="Feishu bots" trailing={<OnDot on={feishu.data?.allowed} />} />
        </NavGroup>
      </div>
    </nav>
  );
}
