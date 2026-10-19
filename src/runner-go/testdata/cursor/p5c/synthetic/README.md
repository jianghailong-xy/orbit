# Synthetic recordings

Hand-built from a real P5c recording's handshake (`../mcp-orbit/session`), for requests the pinned Cursor CLI
never sent in any measured run, so that the runner's answer to them is still covered:

- `ask-question/session`: a `cursor/ask_question` request with one single-choice and one multiple-choice
  question, in the shape the contract gives from source (docs/cursor-runtime-contract.md §4.2,
  `6136.index.js@46614`). P0a and P0c found that the server gives the model no AskQuestion tool in agent or
  plan mode, so no real recording of it exists.

The team veto of `--force` (contract §5.3: a team that turned Run Everything off makes Cursor CLI ask anyway)
needs no recording of its own: it is a permission request arriving in a Bypass session, which the tests replay
from P0's real requests with the session in Bypass.
