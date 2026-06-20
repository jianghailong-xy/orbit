-- Sidebar display order set by drag-to-reorder. NULL = unordered: such agents sort
-- after all positioned ones (by created_at), so existing data keeps its oldest-first
-- order until the user drags an agent to a new slot.
ALTER TABLE "agent" ADD COLUMN "position" INTEGER;
