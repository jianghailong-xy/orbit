import { Fragment, type JSX } from 'react';
import type { ProjectStartSettingKey, ProjectStartSettings } from '@orbit/shared';
import { RUN_SETTING_DIFFERS, runSettingsParts } from '../lib/projectStart';

/**
 * The settings a start left a project running with, in one line — the receipt of the start and
 * the "Project started" card both carry it — with every setting that is not what the coordinator
 * suggested marked where it stands, so whoever reads the line can tell what the owner changed.
 */
export function RunSettingsSummary({
  settings,
  differs = [],
  className,
}: {
  settings: ProjectStartSettings;
  /** The settings that are not what the start was asked for (`differsFromRequest`). */
  differs?: readonly ProjectStartSettingKey[];
  className: string;
}): JSX.Element {
  const parts = runSettingsParts(settings, differs);
  return (
    <div className={className}>
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? ' · ' : null}
          {part.differs ? (
            <b className="run-settings-changed" title={RUN_SETTING_DIFFERS}>
              {part.text}
              <span className="sr-only">{` (${RUN_SETTING_DIFFERS})`}</span>
            </b>
          ) : (
            <span>{part.text}</span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
