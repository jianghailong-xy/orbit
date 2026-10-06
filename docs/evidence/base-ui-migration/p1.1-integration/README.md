# P1.1 集成依赖准备修复

本任务修复 `scripts/worktree-overlay.sh` 的依赖准备，不交付 P1.1 业务特性，也不重跑、关闭或重试其集成作业。

## 输入与可复核候选

- 项目分支开工 tip：`6bbf3ecc3dc2f72193ecb58e6cfb0540753bafce`。
- 本任务交付分支：`orbit/p1-07d1ac`，基于该 tip；实现提交：`ca80677d4a68262a69ea1f04a4b83f17d53f2a21`。
- 已验收的原 P1.1：`703b8f6ce4c75d8975ed867e9808f0f0198716f8`，仅合入验证候选。
- 最终候选：`c7f61251769331f0f2909d4e4d7ee245a01241d7`；tree：`e84b0811c6b2485b9c62b8c01c01f518dca97ae2`。
- 最终候选工作树：`/tmp/orbit-p11-final-aa737ee0`。两个父提交是本任务实现和原 P1.1，准备与检查期间 tracked tree 均干净。
- 执行环境：Linux x64、Node `v26.10.0`、npm `11.19.1`。实现、回归及审查沿用 GPT-6-Astra。

[context.json](context.json) 记录三个候选的提交、树、父提交、锁文件及实现/回归源码 SHA-256。三个候选的 P1.1 锁文件内容相同；未修改依赖声明来规避准备问题。

## 修改前证据

[before-overlay.json](before-overlay.json) / [原始输出](before-overlay.txt)：旧候选 `e01b9d931f79740cb5a10dfd9a7184c49b0fb4c9` 调用真实入口返回 **0**，但仍借用缺少新依赖的 `/root/orbit/node_modules`。

[before-web-check.json](before-web-check.json) / [原始输出](before-web-check.txt)：紧接着执行原命令

```sh
npm run build -w @orbit/web && npm run test -w @orbit/web
```

返回 **1**，构建出现 `@base-ui/react/button` 和 `@base-ui/react/dialog` 的 TS2307，测试因 `&&` 未开始。此候选仅由项目 tip 合并原 P1.1 构成，没有环境修复。

[主安装解析](main-resolution-before.txt)、[P1.1 原安装解析](p11-original-resolution-before.txt) 与[旧候选解析](before-candidate-resolution-before.txt) 对照表明：主安装和空候选缺少这两个入口，原 P1.1 本地安装能解析。

## 修复行为

- 比较候选锁文件与安装的隐藏锁，再核验实际包版本及 workspace 链。额外安装位置可能遮蔽锁定包，因此保守触发隔离安装；不只比较主仓与候选的锁文件。
- 兼容安装可复用。首次升级旧 overlay 或借用来源/锁变化时清理旧覆盖；仅在完整准备成功后写入本树忽略目录中的标记。
- 不兼容时先清除根、`src/node_modules` 和三个 workspace 的依赖目录。删除符号链接只删除链接，不进入共享目录。随后在当前工作树执行 `npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund`。
- `ci` 不改清单/锁文件，忽略 lifecycle 脚本以避免任意 workspace hook 改 tracked 源文件；shared 编译和本树 Prisma 生成仍由真实入口显式完成。
- 兼容的本地私有安装优先保留。Vite 的 `.vite` / `.vite-temp`、Prisma client 与 shared dist 保持工作树隔离。准备错误非零退出。
- npm 允许 optional 包缺席。仅当锁条目为 optional、隐藏安装锁无记录且磁盘路径也不存在时接受省略；已装 optional 与必需包继续核验。没有为 Base UI 或 Vitest 写特殊分支。

## 最终真实检查

每个命令的 `.json` 保存完整命令、cwd、开始/结束时间、候选 commit/tree、退出码及前后 tracked 状态；同名 `.txt` 是未过滤的 stdout/stderr。命令由 [run-command.py](run-command.py) 调用，不用管道掩盖退出码。

| 检查 | 原始记录 | 结果 |
| --- | --- | --- |
| 全空候选预检：无 node_modules、两个 Base UI 入口均缺失 | [final-preflight.json](final-preflight.json) / [输出](final-preflight.txt) | 0 |
| 真实入口 `bash scripts/worktree-overlay.sh` | [final-overlay.json](final-overlay.json) / [输出](final-overlay.txt) | 0；隔离安装 780 包，shared/Prisma 成功 |
| 原 Web 构建与测试命令 | [final-web-check.json](final-web-check.json) / [输出](final-web-check.txt) | 0；291 个文件 / 3,553 项测试通过 |
| 实际模块/目录位置 | [final-paths-before-rerun.json](final-paths-before-rerun.json) / [输出](final-paths-before-rerun.txt) | 0；Base UI、shared、Prisma 及 `.bin` 均在候选内 |
| 重复真实准备与后验路径检查 | [final-overlay-rerun.json](final-overlay-rerun.json) / [输出](final-overlay-rerun.txt)、[路径输出](final-paths-after-rerun.txt) | 均为 0；复用私有安装，未重新 ci 或生成 Prisma |
| 最终回归 | [regression-final.json](regression-final.json) / [TAP](regression-final.txt) | 0；7 个行为场景和 1 个父测试，共 8/8 |

[inspect-candidate.cjs](inspect-candidate.cjs) 独立使用 Node 的实际模块解析和文件系统 realpath 检查，不调用实现的兼容性 helper。

[final-verification.json](final-verification.json) 对比重跑前后 Base UI 包、隐藏安装锁与生成的 Prisma 类型文件的 inode、大小及 mtime，三者均未改变；运行后的两个 Vite cache 目录均为候选内部真实目录。真实准备、原检查和重复准备的 tracked 状态均为空。

共享安装快照覆盖 `/root/orbit/node_modules`、三个 workspace 的 node_modules 及 shared dist，共 **56,919** 个文件/链接记录。常规文件记录大小和内容 SHA-256，符号链接记录目标且不跟随外部路径。开工与所有最终检查后的解压 JSON SHA-256 均为 `47034e1f71e9165f1058ea590c57fa860b37adf910939018998dd89f4277cb18`，变化列表为空：[开工快照](main-install-before.json.gz)、[最终快照](main-install-final.json.gz)、[最终比对](main-install-final.summary.json)。[snapshot-main.py](snapshot-main.py) 可重跑同一只读比对。[最终主安装解析](final-main-resolution.txt) 仍显示两个 Base UI 入口缺失，没有向主安装灌入新包。

## 直接回归与诊断留存

运行：

```sh
node --test --test-reporter=tap scripts/worktree-overlay.test.mjs
```

回归创建临时 Git 主仓与 linked worktree，使用真实 npm、本地 tarball 和独立空缓存；只有重型 tsc/Prisma 工具用最小 fixture 替代。真实完整工具链由上面的最终 P1.1 候选验证。场景覆盖：兼容复用/重复运行；旧共享链接下的陈旧 workspace 包；陈旧私有包；新必需依赖的私有安装及重复运行；必需包安装失败时根/workspace/scoped/.bin 链不污染共享安装；npm 合法省略损坏 optional 包；主安装额外嵌套版本不能遮蔽锁定版本。每条检查包括共享内容指纹及 tracked 文件不变。

[regression-baseline.json](regression-baseline.json) / [TAP](regression-baseline.txt) 使用最终同一份回归源码对开工保存的旧入口运行，退出码 **1**，确认测试能捕获真实旧缺陷。

首次实现的诊断候选 `f26c5ebb4c06d593c5af4db27cd93836448de2f9` 中，npm ci 成功但最初 helper 错将省略的 optional peer esbuild 视为必需项，入口退出 **2**：[after-overlay.json](after-overlay.json) / [日志](after-overlay.txt)。该失败没有修改 tracked tree，之后修正 helper，并另建完全空的最终候选，未用失败候选的预装依赖作为最终验证起点。[optional 修正前回归](regression-optional-before.txt) 也直接捕获了这项缺陷。

普通沙箱阻止 Node 子进程，曾导致路径审计 `spawnSync git EPERM`：[final-inspect.json](final-inspect.json) / [输出](final-inspect.txt)。获准使用正常子进程权限后，成功审计记录为 `final-paths-before-rerun`。这条失败原样保留，不算通过。

## 复现与交付边界

从同一 Git 仓库新建独立候选（不改项目或 main ref）：

```sh
git worktree add --detach /tmp/orbit-p11-recheck ca80677d4a68262a69ea1f04a4b83f17d53f2a21
git -C /tmp/orbit-p11-recheck merge --no-ff --no-edit 703b8f6ce4c75d8975ed867e9808f0f0198716f8
cd /tmp/orbit-p11-recheck
test "$(git rev-parse 'HEAD^{tree}')" = e84b0811c6b2485b9c62b8c01c01f518dca97ae2
bash scripts/worktree-overlay.sh
npm run build -w @orbit/web && npm run test -w @orbit/web
```

私有安装依赖 npm 下载缓存或 registry 可用；若缺少必需包而无法取得，准备必须失败。校验依据 npm 安装锁的版本/来源/完整性记录及实际 package.json，不声称重新计算所有安装包的 tarball 完整性，也不保证任意第三方包内部文件未被人工篡改。

本证据只确立 P1.1 集成依赖准备子范围，不重判 P1.1 的视觉/主题证据，不声称项目已落地或 P1 整阶段完成。没有改 runner、apiserver、业务 UI、历史截图、验收标准或原合并检查；没有部署或重启。修复落地和原 P1.1 的 `integration_retry` 留给协调者；本任务未调用它。回退实现可 revert 上述独立修复提交，回归与证据由后续独立提交保存。
