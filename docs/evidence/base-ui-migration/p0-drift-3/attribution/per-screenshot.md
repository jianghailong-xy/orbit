# 逐张对照（第 3 批）

由 [per-screenshot.py](../tools/per-screenshot.py) 从 [compare/](../compare/) 生成。每格是同环境运行之间的结果：「相同」为逐字节相同；「噪声 n/d」「变化 n/d」为 n 个像素不同、单通道最大差 d，按 p0-drift README「Chromium 渲染噪声」分类。最后一列是 P0 比较器（`maxDiffPixels: 0`、默认 threshold）对照当前期望的结论。`09cc5760d`、`eee179f5d` 与 tip 的 `src/web`、`src/shared` 相同，用 tip 的运行（full-orig-tip）代表；`106c25fc2` 用重跑 full-orig-106c25fc2-r2（第一次运行的两张偶发截图见 README）。「补固定响应前后」是 full-orig-tip → full-fix-tip，「当前期望」是 tip-start 组装的期望。

| 汇总 | fc58e5713 → tip | 422627ef7 → eee179f5d | 106c25fc2 → 98cdd37d0 | 463bb277a → 558a8ba1f | 补固定响应前后 | 当前期望 → 补后 tip |
| --- | --- | --- | --- | --- | --- | --- |
| same | 235 | 232 | 228 | 233 | 248 | 220 |
| noise | 17 | 20 | 24 | 19 | 4 | 15 |
| changed | 0 | 0 | 0 | 0 | 0 | 17 |

P0 比较器对照当前期望不通过的：0 张。

| 截图 | 期望来源 | fc58e5713 → tip | 422627ef7 → eee179f5d | 106c25fc2 → 98cdd37d0 | 463bb277a → 558a8ba1f | 补固定响应前后 | 当前期望 → 补后 tip | P0 比较器 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-dark-desktop/breakpoint-599-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-599-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-601-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-601-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-639-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-639-projects.png | p0.2 | 相同 | 相同 | 噪声 7/4 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-641-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-641-projects.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-959-session.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-959-wiki.png | p0-drift | 噪声 12/2 | 噪声 12/2 | 噪声 12/2 | 相同 | 噪声 12/2 | 相同 | 通过 |
| chromium-dark-desktop/breakpoint-961-session.png | p0-drift | 相同 | 相同 | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 通过 |
| chromium-dark-desktop/breakpoint-961-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/notification-error.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/profile-validation.png | p0-drift | 相同 | 噪声 4/1 | 噪声 8/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/project-graph-fullscreen.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/project-overview.png | p0-drift | 噪声 9/1 | 相同 | 噪声 15/1 | 噪声 9/1 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/session-attachment-menu.png | p0-drift | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/session-attachment-staged.png | p0-drift | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/session-composer-focus.png | p0-drift | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/session-idle.png | p0-drift | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/session-streaming.png | p0-drift | 相同 | 噪声 3/2 | 相同 | 噪声 3/2 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/task-action-focus.png | p0-drift | 相同 | 相同 | 噪声 3/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/task-action-hover.png | p0-drift | 相同 | 相同 | 噪声 3/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/task-action-menu.png | p0-drift | 相同 | 相同 | 噪声 3/1 | 相同 | 相同 | 变化 466/45 | 通过 |
| chromium-dark-desktop/task-detail.png | p0-drift | 相同 | 相同 | 噪声 3/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-desktop/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/notification-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/profile-validation.png | p0-drift | 噪声 10/1 | 噪声 6/1 | 噪声 9/1 | 噪声 30/1 | 相同 | 噪声 18/1 | 通过 |
| chromium-dark-phone/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/project-graph-fullscreen.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/project-overview.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/projects-list.png | p0.2 | 噪声 7/4 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/session-attachment-menu.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/session-attachment-staged.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/session-composer-focus.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/session-idle.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/session-streaming.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/settings-saved.png | p0-drift | 噪声 20/1 | 相同 | 相同 | 相同 | 相同 | 噪声 28/1 | 通过 |
| chromium-dark-phone/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/task-action-focus.png | p0-drift | 噪声 1/1 | 相同 | 相同 | 噪声 1/1 | 相同 | 噪声 69/2 | 通过 |
| chromium-dark-phone/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 噪声 68/2 | 通过 |
| chromium-dark-phone/task-action-menu.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 627/45 | 通过 |
| chromium-dark-phone/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 噪声 68/2 | 通过 |
| chromium-dark-phone/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/wiki-contents.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-dark-phone/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-599-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-599-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-601-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-601-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-639-graph.png | p0-drift | 相同 | 相同 | 噪声 12/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-639-projects.png | p0.2 | 噪声 7/2 | 相同 | 噪声 7/2 | 噪声 7/2 | 相同 | 噪声 7/2 | 通过 |
| chromium-light-desktop/breakpoint-641-graph.png | p0-drift | 噪声 23/1 | 噪声 12/1 | 噪声 12/1 | 相同 | 噪声 12/1 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-641-projects.png | p0.2 | 相同 | 相同 | 噪声 7/2 | 相同 | 相同 | 噪声 7/2 | 通过 |
| chromium-light-desktop/breakpoint-959-session.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-959-wiki.png | p0-drift | 噪声 14/2 | 相同 | 噪声 14/2 | 噪声 14/2 | 相同 | 相同 | 通过 |
| chromium-light-desktop/breakpoint-961-session.png | p0-drift | 相同 | 噪声 3/1 | 相同 | 相同 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/breakpoint-961-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/notification-error.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/profile-validation.png | p0-drift | 相同 | 噪声 28/1 | 噪声 113/2 | 噪声 14/1 | 噪声 9/1 | 相同 | 通过 |
| chromium-light-desktop/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/project-graph-fullscreen.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/project-graph.png | p0-drift | 相同 | 噪声 4/1 | 噪声 4/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/project-overview.png | p0-drift | 噪声 6/1 | 相同 | 噪声 13/1 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/session-attachment-menu.png | p0-drift | 噪声 3/1 | 相同 | 噪声 3/1 | 噪声 3/1 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/session-attachment-staged.png | p0-drift | 噪声 3/1 | 噪声 3/1 | 噪声 3/1 | 噪声 3/1 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/session-composer-focus.png | p0-drift | 噪声 3/1 | 相同 | 噪声 3/1 | 噪声 3/1 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/session-idle.png | p0-drift | 噪声 3/1 | 相同 | 噪声 3/1 | 噪声 3/1 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/session-streaming.png | p0-drift | 噪声 3/1 | 相同 | 噪声 3/1 | 噪声 3/1 | 相同 | 噪声 3/1 | 通过 |
| chromium-light-desktop/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-action-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-action-menu.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/wiki-home.png | p0-drift | 相同 | 相同 | 噪声 28/2 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-desktop/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/notification-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/profile-validation.png | p0-drift | 噪声 7/1 | 噪声 29/2 | 噪声 8/1 | 噪声 10/1 | 噪声 90/1 | 噪声 90/1 | 通过 |
| chromium-light-phone/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/project-graph-fullscreen.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/project-overview.png | p0-drift | 相同 | 噪声 20/1 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/session-attachment-menu.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/session-attachment-staged.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/session-composer-focus.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/session-idle.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/session-streaming.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/settings-saved.png | p0-drift | 相同 | 噪声 23/1 | 相同 | 噪声 6/1 | 相同 | 相同 | 通过 |
| chromium-light-phone/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-action-focus.png | p0-drift | 噪声 2/3 | 噪声 50/1 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-action-hover.png | p0-drift | 相同 | 噪声 50/1 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-action-menu.png | accepted | 相同 | 噪声 50/1 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-detail.png | p0-drift | 相同 | 噪声 50/1 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/wiki-contents.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| chromium-light-phone/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-599-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 11/1 | 通过 |
| webkit-dark-desktop/breakpoint-599-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-601-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 11/1 | 通过 |
| webkit-dark-desktop/breakpoint-601-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-639-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-639-projects.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-641-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-641-projects.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-959-session.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-959-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-961-session.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/breakpoint-961-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/notification-error.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/profile-validation.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/project-graph-fullscreen.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/project-overview.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/session-attachment-menu.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/session-attachment-staged.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/session-composer-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/session-idle.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/session-streaming.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 780/35 | 通过 |
| webkit-dark-desktop/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 780/35 | 通过 |
| webkit-dark-desktop/task-action-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/task-action-menu.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 489/45 | 通过 |
| webkit-dark-desktop/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-desktop/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/notification-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/profile-validation.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/project-graph-fullscreen.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/project-overview.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/session-attachment-menu.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/session-attachment-staged.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/session-composer-focus.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/session-idle.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/session-streaming.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 428/35 | 通过 |
| webkit-dark-phone/task-action-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 66/1 | 通过 |
| webkit-dark-phone/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 66/1 | 通过 |
| webkit-dark-phone/task-action-menu.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 655/45 | 通过 |
| webkit-dark-phone/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 66/1 | 通过 |
| webkit-dark-phone/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/wiki-contents.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-dark-phone/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-599-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 8/1 | 通过 |
| webkit-light-desktop/breakpoint-599-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-601-dialog.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 8/1 | 通过 |
| webkit-light-desktop/breakpoint-601-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-639-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-639-projects.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-641-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-641-projects.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-959-session.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-959-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-961-session.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/breakpoint-961-wiki.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/notification-error.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/profile-validation.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/project-graph-fullscreen.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/project-overview.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/session-attachment-menu.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/session-attachment-staged.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/session-composer-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/session-idle.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/session-streaming.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 780/33 | 通过 |
| webkit-light-desktop/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 780/33 | 通过 |
| webkit-light-desktop/task-action-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/task-action-menu.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-desktop/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/notification-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/profile-validation.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/profile.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/project-graph-fullscreen.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/project-graph.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/project-overview.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/projects-error.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/projects-list.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/projects-loading.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/projects-search-empty.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/session-attachment-menu.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/session-attachment-staged.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/session-composer-focus.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/session-idle.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/session-streaming.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/settings-saved.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/settings.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 变化 428/33 | 通过 |
| webkit-light-phone/task-action-focus.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/task-action-hover.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/task-action-menu.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/task-detail.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/task-public-share.png | p0.2 | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/task-share-dialog.png | accepted | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/wiki-contents.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/wiki-home.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
| webkit-light-phone/wiki-new-entry.png | p0-drift | 相同 | 相同 | 相同 | 相同 | 相同 | 相同 | 通过 |
