import type { JSX, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WarningFilled } from '@ant-design/icons';
import { routeId } from '../lib/idCodec';
import { projectCoordinatorStatusQuery, projectOpenItemsQuery, sessionQuery } from '../lib/queries';
import {
  LANDING_FIX_COPY,
  landingFixAgainSha,
  landingFixBranchWords,
  landingFixColumnCards,
  landingFixFailureWords,
  landingFixSteps,
  type LandingFixTurn,
} from '../lib/landingFix';
import { LandingLink } from './LandingLink';
import { Glyph, LandingHead, landingOnto } from './ProjectPanoramaHeader';
import { LANDING_PAGE_COPY } from '../lib/landingSession';

/**
 * A failed landing, handed to the session that wrote the work (contract revision 42, §12.5 W6; owner ruling
 * 2026-11-22, docs/mocks/landing-fix-own-session web a ①). The turn's words are written for the agent; the card
 * says the same facts for the reader, from those words alone: which step stopped it and on which commit, the
 * files (or the check's failure lines), that nothing was pushed, the three steps it is asked to take, and the way
 * into the landing. It is Orbit's turn, so it is never drawn as the reader's bubble.
 */
export function LandingFixCard({
  turn,
  seq,
  undelivered,
  queued,
}: {
  turn: LandingFixTurn;
  seq?: number;
  undelivered?: boolean;
  queued?: ReactNode;
}): JSX.Element {
  const failure = landingFixFailureWords(turn);
  const branch = landingFixBranchWords(turn.target);
  return (
    <div className="landing-fix-card" data-seq={seq} data-landing-fix={turn.state}>
      <div className="landing-fix-card-eyebrow">
        <WarningFilled aria-hidden="true" />
        <span>{LANDING_FIX_COPY.FROM_ORBIT_LANDING}</span>
        <span className="landing-fix-card-pill">
          {turn.state === 'CONFLICT' ? LANDING_FIX_COPY.CONFLICT : LANDING_FIX_COPY.CHECKS_FAILED}
        </span>
      </div>
      <div className="landing-fix-card-title">{`${LANDING_FIX_COPY.COULD_NOT_LAND_ON} ${turn.target}`}</div>
      <div className="landing-fix-card-line">
        {failure.before}
        {failure.sha ? <code>{failure.sha}</code> : null}
        {failure.after}
        {' '}
        <b>{LANDING_FIX_COPY.NOTHING_WAS_PUSHED}</b>
      </div>
      {turn.lines.length > 0 ? (
        <pre className="landing-fix-card-files">{turn.lines.join('\n')}</pre>
      ) : null}
      {turn.steps.length > 0 ? (
        <ol className="landing-fix-card-steps">
          {landingFixSteps(turn).map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}
      <div className="landing-fix-card-foot">
        {LANDING_FIX_COPY.FOOT(branch)}
        {turn.landingSessionId ? (
          <>
            {' · '}
            <LandingLink className="landing-fix-card-open" sessionId={turn.landingSessionId} />
          </>
        ) : null}
      </div>
      {undelivered ? <div className="bgwake-undelivered">The session has not confirmed it received this.</div> : null}
      {queued ? <div className="bgwake-queued">{queued}</div> : null}
    </div>
  );
}

/**
 * The one line a session that fixed its own landing gets once its fix is landing again (web a ③):
 * `Landing 4be19c2 again · Open landing ›`, in the place of the session's landing label. Read off the landing's own
 * timeline — the newest `Fixed in` row this session wrote — and only while that attempt is the landing's newest and
 * the landing has not settled; otherwise the label the session always had (`fallback`).
 */
export function LandingFixAgainLine({
  landingSessionId,
  sessionId,
  fallback,
}: {
  landingSessionId: string;
  sessionId: string;
  fallback: ReactNode;
}): JSX.Element {
  const landingQ = useQuery(sessionQuery(landingSessionId));
  const landing = landingQ.data?.landing ?? null;
  const newest = landing?.timeline?.sections.at(-1) ?? null;
  const fixedHere = newest?.entries.some((entry) => entry.kind === 'FIXED_BY_SESSION') === true;
  const sha = landing && !landing.settledAt && fixedHere
    ? landingFixAgainSha({ timeline: { ...landing.timeline!, sections: [newest!] } }, sessionId,
      (a, b) => routeId(a) === routeId(b))
    : null;
  if (!sha) return <>{fallback}</>;
  return (
    <div className="session-source-landing">
      <span className="landing-fix-again" data-landing-fix-again={sha}>
        <Glyph shape="spinner" color="currentColor" size={11} />
        {`${LANDING_FIX_COPY.LANDING} `}
        <code>{sha}</code>
        {` ${LANDING_FIX_COPY.AGAIN} · `}
        <LandingLink className="landing-fix-card-open" sessionId={landingSessionId} />
      </span>
    </div>
  );
}

/**
 * The project sessions page's landing card for a landing in its own session's hands, and for one that session
 * handed back (web a ③, b ①, c; the board: "the project page's Landing card keeps today's parts, with one more
 * state word, Fixing"). Today's card is drawn for a job in flight; a landing that stopped and went to its task's
 * session has none, so these are read off the project's open items — the items in a session's hands
 * (`withWorkSession`) and those it handed back (`workSession.returnedAt`) — with the same head, body and foot.
 */
export function SessionProjectLandingFixes({ projectId, now }: { projectId: string; now: number }): JSX.Element | null {
  const items = useQuery({ ...projectOpenItemsQuery(projectId), refetchInterval: 20_000 });
  const cards = landingFixColumnCards(items.data, now);
  const coordinatorQ = useQuery({ ...projectCoordinatorStatusQuery(projectId), enabled: cards.some((card) => card.state === 'RETURNED') });
  const coordinatorId = coordinatorQ.data?.coordination?.sessionId ?? null;
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => {
        const fixing = card.state === 'FIXING';
        const door = fixing ? card.sessionId : coordinatorId;
        return (
          <div key={card.itemId} className={`session-project-landing ${fixing ? 'is-fixing' : 'is-handed-back'}`}
            data-landing-fix-card={card.state}>
            <div className="spl-press">
              <LandingHead
                title={LANDING_FIX_COPY.LANDING}
                head={{ right: fixing ? LANDING_FIX_COPY.FIXING : LANDING_PAGE_COPY.NOT_LANDED, isClock: false, detail: card.detail }}
                running={false}
                timedOut={false}
                failed={!fixing}
              />
              <span className="spl-what">{card.task}</span>
              {card.target ? <span className="spl-ref">{landingOnto(card.target)}</span> : null}
              <span className="spl-det">{card.line}</span>
            </div>
            <div className="spl-foot">
              {door ? (
                <LandingLink className="spl-primary" sessionId={door}>
                  {fixing ? LANDING_FIX_COPY.OPEN_SESSION : LANDING_PAGE_COPY.OPEN_COORDINATOR}
                </LandingLink>
              ) : null}
              {card.landingSessionId ? <LandingLink className="spl-open" sessionId={card.landingSessionId} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
