-- 0455 — where an `orbit register` came from: the address that started a device enrollment (POST
-- /runner/device/start), as the apiserver reads the client behind its proxies (shared/public-surface.guard.ts,
-- visitorAddress). The approval page shows it beside the account, and says when it is the address the page itself
-- was read from: a register link someone else started and sent to the owner shows a code that always matches, and
-- where the request came from is what gives it away.
--
--   device_enrollment.requester_ip   TEXT, canonical (IPv4 dotted, IPv6 shortest lowercase); NULL for requests started
--                                    before this column, and when no address could be read.
--
-- A catalog-only ADD COLUMN, nullable, with no default: no row is read, written or backfilled. No index, trigger,
-- function or constraint; no trigger is declared on "device_enrollment".
--
-- 0455, renumbered from 0452 at landing (2026-10-28): main took 0453 and 0454 while the task ran, and the ledger
-- only appends. 0455 was free on main, on every ref in this repository and in every worktree on this host. The
-- statement can run twice.

ALTER TABLE "device_enrollment" ADD COLUMN IF NOT EXISTS "requester_ip" TEXT;
