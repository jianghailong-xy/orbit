# First-launch tracking and 30-day review

How Orbit's first public launch is sequenced, tagged per channel, measured for 30 days, and reviewed.
The words used in posts come from the [first-launch copy pack](launch-copy.md); partner stories use the
[case-study template](design-partner-case-study-template.md).

## Sequence

1. **GitHub first — T0.** Launch notes on the announced tag's GitHub Release, then a pinned
   [Announcements](https://github.com/jianghailong-xy/orbit/discussions/categories/announcements) discussion.
   T0 is the discussion's publish time (UTC).
2. **Community sync — T0 to T0+7 days.** Post each channel with its own link from the table below and record the
   post URL and UTC time. Channels that share a referrer domain go out at least three days apart.
3. **Design partners — from T0.** Personal outreach with a per-partner link; each partner is followed through the
   funnel below.
4. **Review — T0+30 days.** One page, using the template at the end of this document.

## Channel link identifiers

Every channel has its own identifier (`ref`). GitHub Insights reports referrers by domain and pages without
query strings, so on GitHub a channel is attributed by its referrer domain; the `utm_*` parameters identify the
channel in the channel's own analytics and in any landing page that counts them. Hacker News and Reddit get the
clean URL because both communities treat tracking parameters as spam and Hacker News de-duplicates by URL.

| Channel | `ref` | Link to post | Attributed on GitHub by | Channel numbers to record |
| --- | --- | --- | --- | --- |
| GitHub Release notes | `gh-release` | `https://github.com/jianghailong-xy/orbit/releases/tag/<tag>` | `github.com` | release asset downloads |
| GitHub Announcements discussion | `gh-announce` | `https://github.com/jianghailong-xy/orbit/discussions/<number>` | `github.com` | reactions, comments |
| Hacker News (Show HN) | `hn` | `https://github.com/jianghailong-xy/orbit` | `news.ycombinator.com` | points, comments, peak rank |
| Reddit r/selfhosted | `reddit` | `https://github.com/jianghailong-xy/orbit` | `reddit.com`, `old.reddit.com`, `out.reddit.com` | upvotes, comments |
| V2EX 分享创造 | `v2ex` | `https://github.com/jianghailong-xy/orbit?utm_source=v2ex&utm_medium=community&utm_campaign=first-launch` | `v2ex.com` | clicks, replies, saves |
| X | `x` | `https://github.com/jianghailong-xy/orbit?utm_source=x&utm_medium=social&utm_campaign=first-launch` | `t.co` | impressions, link clicks |
| LinkedIn | `linkedin` | `https://github.com/jianghailong-xy/orbit?utm_source=linkedin&utm_medium=social&utm_campaign=first-launch` | `linkedin.com`, `lnkd.in` | impressions, clicks |
| Juejin article repost | `juejin` | `https://github.com/jianghailong-xy/orbit?utm_source=juejin&utm_medium=article&utm_campaign=first-launch` | `juejin.cn`, `link.juejin.cn` | reads, likes, comments |
| Zhihu article repost | `zhihu` | `https://github.com/jianghailong-xy/orbit?utm_source=zhihu&utm_medium=article&utm_campaign=first-launch` | `zhihu.com`, `link.zhihu.com` | reads, likes, comments |
| Design-partner outreach | `dp-01`, `dp-02`, … | `https://github.com/jianghailong-xy/orbit?utm_source=design-partner&utm_medium=direct&utm_campaign=first-launch&utm_content=dp-01` | none (chat apps send no referrer) | reply, call, install |

Anything not in the table counts as *direct or other*. Link channels to the repository, not to a landing page
without its own counter: clicks that pass through another page reach GitHub with that page as the referrer, and
the per-channel attribution is lost.

## Funnel stages and sources

Orbit is self-hosted and sends no telemetry, so stages after the repository visit are observable only for
design partners, who run a read-only query on their own database and share its output, and for people who report
a deployment in Discussions.

| Stage | Definition | Public source | Design-partner source |
| --- | --- | --- | --- |
| GitHub visit | Views and unique visitors of the repository | Insights daily views; 14-day unique totals from the snapshots at T0+14 and T0+28 | — |
| Interest | Stars, forks, watchers gained after T0 | GitHub API timestamps | — |
| Install | Control plane running with a first account | macOS client downloads (release assets) and deployment reports, as proxies | `install.installed_at` |
| Runner online | A runner registered and sent a heartbeat | deployment reports | `runner.first_registered_at`, `runner.ever_online` |
| First task | First agent session or task; first run that succeeded | deployment reports | `first_task.*` |
| Successful landing | First change merged by Orbit, confirmed by the partner | deployment reports | `landing.first_landed_at`, `landing.merge_receipts_landed` |
| Human intervention | Approvals a person answered, messages into task runs, interrupts | — | `human_intervention.*`, interview |
| Return visit | Active on a second day and after the first week | returning discussion or issue authors | `return_visits.*` |

Clones are recorded but not used as an install signal: CI checkouts and the maintainers' own runners dominate
them (8,691 clones from 1,036 unique cloners against 193 views in the 14 days before launch).

## Collection

- **GitHub, twice a day.** [`scripts/launch-metrics/github-snapshot.sh`](../scripts/launch-metrics/github-snapshot.sh)
  writes one JSON file per run (repository counters, traffic, referrers, popular paths, release downloads). GitHub
  keeps traffic for 14 days only, so a missed week cannot be recovered.
- **Design partners, at T0+7, T0+14 and T0+30.** Each partner runs
  [`scripts/launch-metrics/partner-funnel.sql`](../scripts/launch-metrics/partner-funnel.sql) and sends the JSON row.
  It is read-only and returns counts and first-seen times, never names, hosts, prompts, or message text.
- **Channels, at T0+1, T0+7 and T0+30.** The numbers listed in the channel table, copied by hand.

Partner records — contacts, attribution choice, consent, quotes — stay in the maintainers' private notes, never in
this repository. A public review reports partners as `dp-01`, `dp-02`, … unless a partner chose to be named.

## Pre-launch baseline

Snapshot of 2026-09-29, before T0:

| Signal | Value |
| --- | --- |
| Views, 2026-09-10 to 2026-09-23 | 193 views, 12 unique visitors |
| Referrers in the same window | `github.com` 4 views, Google 1 view |
| Stars / forks / watchers | 4 / 4 / 0 |
| macOS client downloads, all releases | 91 |

## 30-day review template

```markdown
# Orbit first launch — 30-day review (T0 <date> to <date>)

## Launch facts
- Tag announced, release URL, announcement URL, T0 (UTC)
- Channels posted: ref, post URL, UTC time

## Funnel
| Stage | Public | Design partners (n = ) | Conversion from previous stage | Source |
| GitHub visit | | | | |
| Interest | | | | |
| Install | | | | |
| Runner online | | | | |
| First task | | | | |
| Successful landing | | | | |
| Return visit | | | | |
Human intervention per partner: approvals answered, messages into task runs, interrupts, and what they were for.

## Channels
| ref | Posted | Referrer views / uniques | Channel numbers | Partners or reports that came from it |

## What we learned
Three to five findings, each with its evidence and the stage it explains.

## Next round
- Keep: action, the number that justifies it, owner
- Stop: action, the number that justifies it
- Add: action, the gap it closes, owner

## Data gaps and corrections
```
