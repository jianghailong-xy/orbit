import { ApiError } from '../api';

export type OwnerRatificationDecision = 'APPROVE' | 'DENY';

/**
 * Why a decision was not submitted, in terms the owner can act on.
 *
 * Shared verbatim by every owner-credentialed decision surface — the standalone review page and
 * the in-conversation card — so "approve what you saw" fails the same way wherever it is shown.
 * A typed code is the point: the guarantee this task rests on is that a contract which changed
 * between rendering and approving is REFUSED, and a refusal the UI cannot name is one the reader
 * cannot distinguish from a network hiccup.
 */
export interface OwnerRatificationFailure {
  code: string;
  message: string;
  /** The current request must be re-read and re-rendered before another decision is possible. */
  reloadCurrent: boolean;
  /** The result is unknown rather than refused: the SAME idempotency key may be replayed. */
  networkRetry: boolean;
}

export function newOwnerRatificationIdempotencyKey(
  requestId: string,
  decision: OwnerRatificationDecision,
  surface = 'web',
): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? Array.from(globalThis.crypto?.getRandomValues?.(new Uint32Array(4)) ?? [Date.now()])
      .map((part) => part.toString(16)).join('-');
  return `owner-ratification:${surface}:v1:${requestId}:${decision}:${random}`;
}

/** Never expose server/driver prose here: a future error must not turn request input into UI text. */
export function ownerRatificationFailure(error: unknown): OwnerRatificationFailure {
  if (!(error instanceof ApiError)) {
    return {
      code: 'NETWORK_UNCERTAIN',
      message: '网络结果未知；可以使用同一幂等键安全重试，或重新读取当前 request。',
      reloadCurrent: true,
      networkRetry: true,
    };
  }
  const code = error.code ?? (error.status === 404 ? 'NOT_AVAILABLE_TO_OWNER' : 'REQUEST_FAILED');
  if (code === 'OWNER_DECISION_STALE') {
    return { code, message: '契约或 request 已更新；旧 tab 未提交决定。请载入当前 request。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'OWNER_DECISION_CTA_EXPIRED') {
    return { code, message: '一次性 CTA 已到期；服务器已生成可恢复的新 request。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'OWNER_DECISION_ALREADY_SPENT') {
    const recorded = error.body?.recordedDecision;
    return {
      code,
      message: recorded === 'APPROVE' || recorded === 'DENY'
        ? `此 CTA 已由另一次点击或客户端提交 ${recorded}；请读取服务器记录的决定。`
        : '此 CTA 已被另一次点击或客户端消费；请读取已提交结果或当前 request。',
      reloadCurrent: true,
      networkRetry: false,
    };
  }
  if (code === 'OWNER_DECISION_IDEMPOTENCY_COLLISION') {
    return {
      code,
      message: '该幂等键已绑定另一组 request/digest/CTA/decision；本次未提交，请重新读取。',
      reloadCurrent: true,
      networkRetry: false,
    };
  }
  if (code === 'OWNER_DECISION_CTA_MISMATCH') {
    return { code, message: 'CTA 与当前 request 不匹配；未提交决定。请重新载入。', reloadCurrent: true, networkRetry: false };
  }
  if (code === 'NOT_AVAILABLE_TO_OWNER' || error.status === 403) {
    return { code, message: '该 project/request 对当前账号不可用；没有提交任何决定。', reloadCurrent: false, networkRetry: false };
  }
  return {
    code,
    message: '决定未得到可确认的提交结果；请重新读取当前 request 后再操作。',
    reloadCurrent: true,
    networkRetry: false,
  };
}
