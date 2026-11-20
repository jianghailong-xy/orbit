/**
 * The Anthropic Messages ⇄ OpenAI Responses translator of the /api/gw/anthropic gateway
 * (docs/claude-engine-openai-gateway-design.md §4.3–§4.5). A pure module: no I/O, so the gateway around it
 * owns the network, tokens, keys and logs.
 */
export { toResponsesRequest, toInputTokensRequest, estimateInputTokens, type Effort, type TranslateContext, type TranslatedRequest } from './request';
export { MessagesStreamConverter, assembleMessage, anthropicError, messagesUsage, toSse, PING_SSE, type MessagesEvent, type StreamContext } from './stream';
export { encodeReasoningSignature, decodeReasoningSignature, ENVELOPE_PREFIX, type ReasoningEnvelope } from './envelope';
export { upstreamModel, type ModelContext } from './models';
