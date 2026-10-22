# `agent login` 的完整计时（macOS，NO_OPEN_BROWSER=1）

- `login-file-store.txt`：`AGENT_CLI_CREDENTIAL_STORE=file`，隔离 HOME（`<P0_ROOT>/runs/login-timing/home-file`）。
  2026-10-17T01:25:13Z 启动，链接立刻打印；**01:50:45Z 超时**（`Login failed or timed out. Please try again.`，exit 1）——**1,532 s（约 25.5 分钟）**。
  Linux 参考值 1,632 s / 1,636 s（P0a，两次独立计时）。
- `login-default-store.txt`：默认存储（Keychain）+ 真 HOME，2026-10-17T01:25:14Z 启动，01:26:50Z 被任务主动终止
  （该运行会向真实 `~/.cursor` 写 cli-config.json 和 statsig-cache.json，为遵守「不写真实 ~/.cursor」提前结束并清理）。
  记录它只是为了对照：默认存储下链接打印行为与 file 存储相同。
- 两次运行都没有完成登录（没人打开链接），期间不写任何凭据。
