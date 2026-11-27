import { ClockCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import {
  SESSION_MARKS,
  SESSION_ROW_ICON_TIPS,
  type SessionDisplayState,
  type SessionMark,
  type SessionRowIcon,
} from '../lib/sessionDisplay';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from './ui/Tooltip';

/**
 * How the web draws what lib/sessionDisplay decides (the approved board, docs/mocks/session-display-three-states):
 * the state icon, and the marks as small labelled chips after the state word. Drawing only: neither component decides
 * anything about the session.
 */

const svg = (body: ReactNode, size: number) => (
  <svg
    className="session-mark-svg"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {body}
  </svg>
);

/** The state icon: a grey clock for Queued, the blue spinner for Running, an empty grey circle for Idle. */
export function SessionStateGlyph({ state, size = 16 }: { state: SessionDisplayState; size?: number }) {
  const label = state.word;
  if (state.icon === 'spinner')
    return (
      <Tooltip content={label} delay={TEXT_TOOLTIP_DELAY_MS}>
        <span aria-label={label} className="session-state-glyph" data-state={state.phase}>
          <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize: size }} />
        </span>
      </Tooltip>
    );
  if (state.icon === 'clock')
    return (
      <Tooltip content={label} delay={TEXT_TOOLTIP_DELAY_MS}>
        <span aria-label={label} className="session-state-glyph" data-state={state.phase}>
          <ClockCircleOutlined style={{ color: 'var(--scrollbar-hover)', fontSize: size }} />
        </span>
      </Tooltip>
    );
  return (
    <Tooltip content={label} delay={TEXT_TOOLTIP_DELAY_MS}>
      <span aria-label={label} className="session-state-glyph" data-state={state.phase} style={{ color: 'var(--text-3)' }}>
        {svg(<circle cx="8" cy="8" r="6.25" />, size)}
      </span>
    </Tooltip>
  );
}

const MARK_ICON: Record<SessionMark, ReactNode> = {
  NEEDS_YOU: (
    <path d="M5.5 8.5V3.8a1 1 0 0 1 2 0V8M7.5 7V2.8a1 1 0 0 1 2 0V8M9.5 7.2V3.8a1 1 0 0 1 2 0v5.4c0 2.6-1.6 4.3-4 4.3-1.7 0-2.6-.8-3.6-2.3L2.6 8.6a1 1 0 0 1 1.6-1.1l1.3 1.5" />
  ),
  FAILED: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  RETRYING: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.6h-2.6" />,
  ON_HOLD: <path d="M6 4v8M10 4v8" />,
};

const ROW_ICON: Record<SessionRowIcon, ReactNode> = {
  BACKGROUND: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.5 6.2l2 1.8-2 1.8M8 10h3.5" />
    </>
  ),
  WILL_RESUME: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
};

/** A list row's title-line icons (lib/sessionDisplay sessionRowIcons), beside the guests icon: each a grey glyph whose
 *  tip says what it means. */
export function SessionRowIcons({ icons }: { icons: readonly SessionRowIcon[] }) {
  return (
    <>
      {icons.map((icon) => (
        <Tooltip key={icon} content={SESSION_ROW_ICON_TIPS[icon]} align="end" delay={TEXT_TOOLTIP_DELAY_MS}>
          <span className="session-row-icon" data-icon={icon} aria-label={SESSION_ROW_ICON_TIPS[icon]}>
            {svg(ROW_ICON[icon], 12)}
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/** The marks after the state word, in the order given. `max` (a narrow row) draws the first ones and "+N" for the rest. */
export function SessionMarkChips({ marks, max }: { marks: readonly SessionMark[] | null; max?: number }) {
  if (!marks || marks.length === 0) return null;
  const shown = max ? marks.slice(0, max) : marks;
  const more = max && marks.length > max ? marks.length - max : 0;
  return (
    <span className="session-marks">
      {shown.map((mark) => (
        <span key={mark} className={`session-mark tone-${SESSION_MARKS[mark].tone}`} data-mark={mark}>
          {svg(MARK_ICON[mark], 11)}
          {SESSION_MARKS[mark].word}
        </span>
      ))}
      {more > 0 && <span className="session-mark is-more">+{more}</span>}
    </span>
  );
}
