# The status word of a session row, for the drills that print or wait on it: derived from the row's facts by the
# server's own SQL projector (migration 1621; docs/session-status-retirement-plan.md §2.6). Source it; the shell twin
# of session-word.mjs. The projector reads no stored word: session.status left with deploy D4 (migration 1711).

# session_word_sql ROW: SQL text for the word of the session row the query names ROW (a constant, never input).
session_word_sql() {
  printf 'session_legacy_status(%s.finished_at, %s.turn_state, %s.end_reason, %s.last_turn_outcome, %s.started_at, %s.import_source_cwd, %s.kind, (SELECT l.settled_as FROM project_landing l WHERE l.session_id = %s.id))' \
    "$1" "$1" "$1" "$1" "$1" "$1" "$1" "$1"
}
