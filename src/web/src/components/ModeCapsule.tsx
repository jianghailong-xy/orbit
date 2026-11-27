import { LoadingOutlined } from '@ant-design/icons';
import { permissionModeLabel, type ModeCapsule } from '../lib/sessionPermissionMode';

/**
 * What the composer's Mode capsule says (docs/mocks/permission-mode-actual, the owner's A1): the mode the
 * engine runs in; "Default → Auto" with a spinner while it switches to the mode asked for; an amber dot
 * beside it while a gap lasts.
 */
export function ModeCapsuleValue({ capsule }: { capsule: ModeCapsule }) {
  if (capsule.gap === 'none') return <>{capsule.label}</>;
  return (
    <span className="composer-mode-value">
      {capsule.gap === 'switching' ? (
        <LoadingOutlined spin className="composer-mode-spin" aria-hidden />
      ) : (
        <span className="composer-mode-dot" aria-hidden />
      )}
      {capsule.to === null ? (
        capsule.label
      ) : (
        <>
          {permissionModeLabel(capsule.mode)} <span className="composer-mode-arrow">→</span> {capsule.to}
        </>
      )}
    </span>
  );
}

/** A row of the Mode menu: the mode's name, and after it, quieter, what it does here ("— not on Haiku 4.5, runs
 *  as Default"), as the board draws it. */
export function ModeOptionLabel({ label }: { label: string }) {
  const at = label.indexOf(' — ');
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)} <span className="composer-mode-note">— {label.slice(at + 3)}</span>
    </>
  );
}

/** Why the capsule is not the mode asked for, at the head of the Mode menu: its first sentence in amber. */
export function ModeReason({ reason }: { reason: { lead: string; rest: string } }) {
  return (
    <>
      <b>{reason.lead}</b> {reason.rest}
    </>
  );
}
