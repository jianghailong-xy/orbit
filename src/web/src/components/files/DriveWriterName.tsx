import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { DriveWriter } from '../../lib/drive';
import { sessionQuery } from '../../lib/queries';

/** Said where an agent wrote and its session could not be checked (rule 6): no link, since there is none to follow. */
export const UNCHECKED_AGENT = 'An agent on Orbit Cloud';

/** An agent whose session is known: "Agent in <the session's title>", a link to that session. */
function AgentInSession({ sessionId }: { sessionId: string }) {
  const session = useQuery({ ...sessionQuery(sessionId), retry: false, staleTime: 5 * 60_000 });
  const title = session.data?.title?.split('\n')[0]?.trim();
  return (
    <Link className="files-writer-agent" to={`/sessions/${sessionId}`} onClick={(event) => event.stopPropagation()}>
      {title ? `Agent in ${title}` : 'Agent in a session'}
    </Link>
  );
}

/**
 * Who last wrote a file (§3.6, board rule 6): "You" for the owner; "Agent in <session>" with a link where the session
 * was checked; otherwise "An agent on Orbit Cloud".
 */
export function DriveWriterName({ writer }: { writer: DriveWriter }) {
  if (writer.kind === 'OWNER') return <span className="files-writer-you">You</span>;
  if (writer.sessionId) return <AgentInSession sessionId={writer.sessionId} />;
  return <span className="files-writer-cloud">{UNCHECKED_AGENT}</span>;
}
