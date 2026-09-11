# Codex earned rate-limit reset — 上游协议快照（codex-cli 0.154.0）

[`docs/codex-rate-limit-reset-contract.md`](../../codex-rate-limit-reset-contract.md) §2 的权威来源。

- 生成方式：`codex app-server generate-json-schema --out <dir>`（本机 `codex-cli 0.154.0`，2026-09-11）。
  本目录的 6 个文件是 `<dir>/v2/` 下同名文件的逐字节拷贝；加 `--experimental` 生成的 4 个 reset 相关文件与之逐字节相同。
- 只做了 schema 生成，**没有**调用 `account/rateLimitResetCredit/consume`，没有消费任何真实 credit。
- `contracts/codex-rate-limit-reset.contract.json` 的 outcome 枚举、consume 参数与 `RateLimitResetCredit` 字段集，
  由 `src/shared/src/codexRateLimitReset.spec.ts` 与 `src/runner-go/codex_rate_limit_reset_test.go` 对照本目录断言。

| 文件 | 用途 |
| --- | --- |
| `GetAccountRateLimitsResponse.json` | `account/rateLimits/read` 响应：顶层 `rateLimitResetCredits`、`accountId` |
| `NullableGetAccountRateLimitsParams.json` | read 参数（`excludeResetCreditDetails`） |
| `ConsumeAccountRateLimitResetCreditParams.json` | consume 参数：必填 `idempotencyKey`，可选 `creditId` |
| `ConsumeAccountRateLimitResetCreditResponse.json` | consume 响应：四种 `outcome` 及官方描述 |
| `GetAccountResponse.json` / `GetAccountParams.json` | `account/read`：账户类型（`chatgpt` / `apiKey` / `amazonBedrock`） |
