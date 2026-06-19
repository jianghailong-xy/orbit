-- TaskComment.mentions: agent ids @-mentioned in a comment (web composer). Each mention
-- notifies and triggers that agent on the task. No FK (cf. author_id polymorphic actor).
ALTER TABLE "task_comment" ADD COLUMN "mentions" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
