# Session list scale measurement

Before/after of the web session list on a seed of 1,500 Open sessions in one workspace with folders and
projects (docs/session-list-scale-design.md §5 T4).

```bash
node src/web/perf/session-list-scale/measure.mjs \
  --before b0bf3799bed176cec027d3c2811082b722751134 \
  --after  0522c25db849a345daec87225a7d8f1a3f988af2 \
  --work /mnt/tmp/session-list-scale/work --out /mnt/tmp/session-list-scale/results \
  --runs 10 --frames 20 --max-load 16
```

It needs Docker (`postgres:16-alpine`, `nginx:alpine`), the Node version the repository asks for and
Playwright's Chromium. For each commit it makes a detached worktree under `--work` (kept, so a second run
skips the builds; remove with `git worktree remove`), runs `scripts/worktree-overlay.sh` in it, builds the
apiserver and the web app, then starts:

- one PostgreSQL, migrated and seeded once (`seed.mjs`) and copied per build, so both read the same rows;
- the build's real apiserver (`dist/main.js`) on its copy;
- nginx with the build's `src/web/nginx.conf` serving the web build and proxying `/api`, plus the gzip
  settings of `gateway/nginx.conf`;
- a second web build with React's profiling renderer (`profiling.vite.config.mjs`), used only for commit times.

Loads are cold (a new browser context each), at 1440×900, with no network or CPU throttling, and the two builds
take turns. `--max-load` holds each timed step until the host is that quiet. `--out` gets `results.json`, `table.md` (also `node report.mjs results.json`) and the logs.

| Metric | How it is read |
| --- | --- |
| First list response bytes | the body, and the bytes on the wire, of the first Open-list read of the workspace made during the load (what the column is first drawn from; every list read of the load is summed beside it): `GET /api/sessions?…&view=open` before, `GET /api/sessions/listing` after |
| Time to interactive list | from navigation until the splash is gone, the folder rows and a session row are drawn, and a task runs after the next painted frame |
| One watch frame | a watch that will resume a session on screen is created, then cancelled, through `POST /api/watches`. Commit time is React's `actualDuration` (render time, as `<Profiler>` reports it) of the commits between the new `/watches` answer and the row's new line (profiling build); the shipped build also gives the time from that answer to the DOM change and to the painted frame |
| Mounted session rows | `.session-row` elements in the session column after the load, and after scrolling to its end a screen at a time until no more arrives |
