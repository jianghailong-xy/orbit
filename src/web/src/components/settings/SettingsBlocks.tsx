import { useId, type ReactNode } from 'react';
import './Settings.css';

/** A page's own heading in the right-hand column: its name, a line under it, and an optional action on its right. */
export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="settings-header">
      <div className="settings-header-text">
        <h1 className="settings-header-title">{title}</h1>
        {description != null && <p className="settings-header-description">{description}</p>}
      </div>
      {action != null && <div className="settings-header-action">{action}</div>}
    </header>
  );
}

/**
 * The pieces every Settings page is drawn from (docs/mocks/settings-redesign): a section with a title
 * (and an optional action on its right), a rounded card under it, and in the card one setting per row —
 * its name and a one-line description on the left, its control on the right.
 */
export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** A page's own name for the section, beside settings-section. */
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={className ? `settings-section ${className}` : 'settings-section'} aria-labelledby={titleId}>
      <div className="settings-section-head">
        <h2 className="settings-section-title" id={titleId}>
          {title}
        </h2>
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
  tooltip,
  anchor,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  /** The full text, where the description is a shortened one: said when the pointer rests on the control. */
  tooltip?: string;
  /** The row's name on its page: Settings' search opens the page at it and flashes it. */
  anchor?: string;
}) {
  return (
    <div className="settings-row" data-setting-anchor={anchor}>
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {description != null && <div className="settings-row-description">{description}</div>}
      </div>
      {control != null && (
        <div className="settings-row-control" title={tooltip}>
          {control}
        </div>
      )}
    </div>
  );
}
