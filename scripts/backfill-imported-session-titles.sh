#!/usr/bin/env bash
# One-time backfill: name the imported sessions that still read "Imported session 4e453ab7".
#
#   scripts/backfill-imported-session-titles.sh            # dry run: list what would change
#   scripts/backfill-imported-session-titles.sh --apply    # write it, in one transaction
#
# Why: an import takes its title from the transcript's `ai-title` record, and Claude Code writes
# none for a `claude -p` or Agent SDK conversation (nor for every interactive one). Until
# SessionsService.nameUntitledImport, nothing else named such a session, so every one imported
# before that fix kept its placeholder. This gives each the title that fix gives a new one: the
# first non-blank line of its first real prompt, trimmed and cut to 80 characters, read from the
# run events the import stored. Text Claude Code itself put in the user's turn — anything opening
# with `<` (command wrappers, local command output) or `Caveat:` — is passed over, as there.
#
# Only a row still reading exactly its placeholder, live (not in Trash) and with no project owning
# its title is touched, so a rename made by hand stands and a second run changes nothing. A
# session with no prompt to read keeps its placeholder. Open clients show the new titles on their
# next refresh; nothing is announced live, and no model is asked for a cleaner title.
set -eu

PG_CONTAINER="${ORBIT_PG_CONTAINER:-orbit-postgres}"
PG_USER="${ORBIT_PG_USER:-orbit}"
PG_DB="${ORBIT_PG_DB:-orbit}"

APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  -h | --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
  *)
    echo "backfill-imported-session-titles: unknown argument '$1' (--apply or nothing)" >&2
    exit 2
    ;;
esac

docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -qx true || {
  echo "backfill-imported-session-titles: container '$PG_CONTAINER' is not running (set ORBIT_PG_CONTAINER)" >&2
  exit 1
}

# -X so a ~/.psqlrc cannot change what runs; ON_ERROR_STOP so a failed statement rolls the
# transaction back instead of committing the half before it.
pg() { docker exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -P pager=off "$@"; }

CANDIDATES="
WITH candidate AS (
  SELECT s.id, s.title AS old_title, p.title AS new_title
  FROM session s
  CROSS JOIN LATERAL (
    SELECT left(regexp_replace(l.line, '^\\s+|\\s+\$', '', 'g'), 80) AS title
    FROM (
      SELECT e.seq, e.payload->>'text' AS text
      FROM run_event e
      WHERE e.session_id = s.id AND e.type = 'user'
      ORDER BY e.seq
      LIMIT 20
    ) u
    CROSS JOIN LATERAL regexp_split_to_table(u.text, E'\\n') WITH ORDINALITY AS l(line, n)
    WHERE u.text ~ '\\S'
      AND u.text !~ '^\\s*(<|Caveat:)'
      AND l.line ~ '\\S'
    ORDER BY u.seq, l.n
    LIMIT 1
  ) p
  WHERE s.imported_at IS NOT NULL
    AND s.deleted_at IS NULL
    AND s.title_managed_by_project = false
    AND s.runtime_session_id IS NOT NULL
    AND s.title = 'Imported session ' || left(s.runtime_session_id, 8)
)"

if [ "$APPLY" -eq 0 ]; then
  pg <<SQL
$CANDIDATES
SELECT id, old_title, new_title FROM candidate ORDER BY id;
$CANDIDATES
SELECT count(*) AS still_placeholder_after_backfill
FROM session s
WHERE s.imported_at IS NOT NULL AND s.deleted_at IS NULL
  AND s.title = 'Imported session ' || left(s.runtime_session_id, 8)
  AND s.id NOT IN (SELECT id FROM candidate);
SQL
  echo "Dry run: nothing written. Rerun with --apply to rename the sessions listed above."
  exit 0
fi

pg <<SQL
BEGIN;
$CANDIDATES
UPDATE session s
SET title = c.new_title, updated_at = now()
FROM candidate c
WHERE s.id = c.id AND s.title = c.old_title AND s.title_managed_by_project = false
RETURNING s.id, c.old_title, s.title AS new_title;
COMMIT;
SQL
