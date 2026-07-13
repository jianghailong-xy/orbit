-- Session.lastUserText: the message the user just sent, denormalized while it's the frontier (a
-- turn started, the agent hasn't replied yet), cleared on the next frontier. Lets the session list
-- show the pending message while awaiting the reply instead of the now-stale previous reply.
ALTER TABLE "session" ADD COLUMN "last_user_text" TEXT;
