-- 1762 — a Scheduled page chat's message carries the page's workspace filter and selected schedule
-- (`{ scheduleFilter?, scheduleId? }`, docs/scheduled-chat-design.md §4.2), as ids. Delivery reads what they name and
-- appends `<orbit_schedules>`, so `content` stays the person's words. Null for every other turn.
ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "schedule_context" JSONB;
