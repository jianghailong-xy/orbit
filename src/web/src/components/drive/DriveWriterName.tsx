import { useQuery } from '@tanstack/react-query';
import { RobotOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { DriveWriter } from '../../lib/drive';
import { sessionQuery } from '../../lib/queries';

/** Said where an agent wrote and its session could not be checked (rule 6): no link, since there is none to follow. */
export const UNCHECKED_AGENT = 'An agent on Orbit Cloud';

/** An agent whose session is known: "Agent in <the session's title>", a link to that session. */
function AgentInSession({ sessionId, glyph }: { sessionId: string; glyph: boolean }) {
  const session = useQuery({ ...sessionQuery(sessionId), retry: false, staleTime: 5 * 60_000 });
  const title = session.data?.title?.split('\n')[0]?.trim();
  const full = title ? `Agent in ${title}` : 'Agent in a session';
  return (
    <Link
      className="files-writer-agent"
      to={`/sessions/${sessionId}`}
      aria-label={glyph ? full : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {glyph ? (
        <>
          <RobotOutlined className="files-writer-glyph" aria-hidden="true" />
          {title ?? 'a session'}
        </>
      ) : (
        full
      )}
    </Link>
  );
}

/**
 * Who last wrote a file (§3.6, board rule 6): "You" for the owner; "Agent in <session>" with a link where the session
 * was checked; otherwise "An agent on Orbit Cloud".
 */
export function DriveWriterName({ writer, glyph = false }: { writer: DriveWriter; /** A small agent glyph in place of the words "Agent in" (the Drive list). */ glyph?: boolean }) {
  if (writer.kind === 'OWNER') return <span className="files-writer-you">You</span>;
  if (writer.sessionId) return <AgentInSession sessionId={writer.sessionId} glyph={glyph} />;
  return <span className="files-writer-cloud">{UNCHECKED_AGENT}</span>;
}
