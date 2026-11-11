import type { ReactNode } from 'react';
import './Settings.css';

/**
 * The pieces every Settings page is drawn from (docs/mocks/settings-redesign): a section with a title
 * (and an optional action on its right), a rounded card under it, and in the card one setting per row —
 * its name and a one-line description on the left, its control on the right.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="settings-section-title">{title}</h2>
        {action != null && <div className="settings-section-action">{action}</div>}
      </div>
      {description != null && <p className="settings-section-description">{description}</p>}
      {children}
    </section>
  );
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="settings-card">{children}</div>;
}

export function SettingsRow({
  title,
  description,
  control,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {description != null && <div className="settings-row-description">{description}</div>}
      </div>
      {control != null && <div className="settings-row-control">{control}</div>}
    </div>
  );
}
