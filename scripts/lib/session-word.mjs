// The status word of a session row, for the drills that print or wait on it: derived from the row's facts by the
// server's own SQL projector (migration 1621, src/apiserver/src/sessions/session-legacy-words.ts), so no script reads
// session.status (docs/session-status-retirement-plan.md §2.6). The last argument is the projector's stored-word
// fallback for a held row not yet backfilled; a drill's rows are written on a migrated database, so it is NULL.
// Task T14 removes that argument.

/** SQL text for the word of the `session` row the query names `row` (a constant, never input). */
export const sessionWordSql = (row) =>
  `session_legacy_status(${row}.finished_at, ${row}.turn_state, ${row}.end_reason, ${row}.last_turn_outcome, `
  + `${row}.started_at, ${row}.import_source_cwd, ${row}.kind, `
  + `(SELECT l.settled_as FROM project_landing l WHERE l.session_id = ${row}.id), NULL)`;
