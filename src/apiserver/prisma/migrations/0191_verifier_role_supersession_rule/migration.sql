-- PostgreSQL does not allow a newly-added enum value to be consumed safely by later statements
-- in the same migration transaction.  Declare the terminal rule here; 0192 applies it.
ALTER TYPE "task_judgment_supersession_rule" ADD VALUE 'VERIFIER_ROLE';
