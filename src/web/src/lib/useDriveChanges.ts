import { useCallback, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { DriveChatChangeGroup } from '@orbit/shared';
import { driveChatsQuery } from './driveChat';
import {
  driveChangesNeedYou,
  driveGroupNeedsYou,
  driveChatGroupsQuery,
  driveChatQuestionsQuery,
  driveMarks,
  readSeenMarks,
  writeSeenMark,
  type DriveMark,
} from './driveChanges';
import { meQuery } from './queries';

/** The most open chats whose changes are read for marks and the round button's count. */
const CHATS_READ = 20;

/**
 * What the owner's open Drive chats changed and asked, over all of them (board drive-chat 01 ③ ⑤): how many held groups and
 * open questions wait on the owner, and the marks the list carries until a marked row is opened. One read per chat, shared
 * with the chat's own cards by the query keys.
 */
export function useDriveChanges(): {
  needsYou: number;
  /** The held groups, each with the title of the chat that holds them. */
  held: { group: DriveChatChangeGroup; chatTitle: string }[];
  markOf: (entryId: string) => DriveMark | null;
  opened: (entryId: string) => void;
} {
  const me = useQuery(meQuery());
  const scope = me.data?.id ?? null;
  const list = useQuery(driveChatsQuery());
  const ids = (list.data?.chats ?? []).filter((chat) => chat.open).slice(0, CHATS_READ).map((chat) => chat.sessionId);
  const working = list.data?.fab.working ?? false;
  const groups = useQueries({ queries: ids.map((id) => driveChatGroupsQuery(id, working)) });
  const questions = useQueries({ queries: ids.map((id) => driveChatQuestionsQuery(id, working)) });
  const [seenVersion, setSeenVersion] = useState(0);

  const allGroups = groups.flatMap((read) => read.data ?? []);
  const allQuestions = questions.flatMap((read) => read.data ?? []);
  const needsYou = driveChangesNeedYou(allGroups, allQuestions);
  const marks = useMemo(
    () => driveMarks(allGroups),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups.map((read) => read.dataUpdatedAt).join(',')],
  );
  const seen = useMemo(
    () => readSeenMarks(scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, seenVersion],
  );
  const markOf = useCallback(
    (entryId: string): DriveMark | null => {
      const found = marks.get(entryId);
      return found && !seen.has(found.key) ? found.mark : null;
    },
    [marks, seen],
  );
  const opened = useCallback(
    (entryId: string) => {
      const found = marks.get(entryId);
      if (!found || seen.has(found.key)) return;
      writeSeenMark(scope, found.key);
      setSeenVersion((n) => n + 1);
    },
    [marks, seen, scope],
  );
  const titles = new Map((list.data?.chats ?? []).map((chat) => [chat.sessionId, chat.title]));
  const held = allGroups.filter(driveGroupNeedsYou).map((group) => ({ group, chatTitle: titles.get(group.sessionId) ?? 'Drive chat' }));
  return { needsYou, held, markOf, opened };
}
