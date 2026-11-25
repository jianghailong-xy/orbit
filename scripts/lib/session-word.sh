# The status word of a session row, for the drills that print or wait on it: derived from the row's facts by the
# server's own SQL projector (migration 1621), so no script reads session.status
# (docs/session-status-retirement-plan.md §2.6). Source it; the shell twin of session-word.mjs. The last argument is
# the projector's stored-word fallback for a held row not yet backfilled; task T14 removes it.

# session_word_sql ROW: SQL text for the word of the session row the query names ROW (a constant, never input).
session_word_sql() {
  printf 'session_legacy_status(%s.finished_at, %s.turn_state, %s.end_reason, %s.last_turn_outcome, %s.started_at, %s.import_source_cwd, %s.kind, (SELECT l.settled_as FROM project_landing l WHERE l.session_id = %s.id), NULL)' \
    "$1" "$1" "$1" "$1" "$1" "$1" "$1" "$1"
}
