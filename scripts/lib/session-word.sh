# The status word of a session row, for the drills that print or wait on it: derived from the row's facts by the
# server's own SQL projector (migration 1621; docs/session-status-retirement-plan.md §2.6). Source it; the shell twin
# of session-word.mjs. The last argument is the stored word, which the projector reads for one thing: a held row with
# no turn_state, as on a database the backfill (task T3) has not reached. It is the one allowed read of session.status
# here, and task T14 removes it with the argument.

# session_word_sql ROW: SQL text for the word of the session row the query names ROW (a constant, never input).
session_word_sql() {
  printf 'session_legacy_status(%s.finished_at, %s.turn_state, %s.end_reason, %s.last_turn_outcome, %s.started_at, %s.import_source_cwd, %s.kind, (SELECT l.settled_as FROM project_landing l WHERE l.session_id = %s.id), %s.status::text)' \
    "$1" "$1" "$1" "$1" "$1" "$1" "$1" "$1" "$1"
}
