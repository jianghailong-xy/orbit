-- 1656: a browser's Web Push subscription keys (docs/web-push-design.md).
--
-- A browser registers as platform 'web' with its subscription's endpoint as the token; the payload is encrypted to
-- these two keys (RFC 8291), so the row needs them. Only web rows set it. One nullable column; no row is written.
ALTER TABLE "device_token" ADD COLUMN "web_keys" JSONB;
