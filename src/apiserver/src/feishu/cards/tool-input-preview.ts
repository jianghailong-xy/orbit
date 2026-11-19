import { redactSecrets } from '../../common/secret-redaction';
import { holdsWorkspaceWriteValues, withoutEnvValues } from '../../sessions/workspace-write-card-values';

/**
 * What a Feishu approval card shows of a tool call's input in the FULL detail mode (docs/feishu-bot-design.md §6.1).
 *
 * The Web approval card draws `JSON.stringify(approval.input, null, 2)` of the input the apiserver serves it, and this
 * is the same text, put through the two scrubs the apiserver already has for it rather than a third:
 *
 *   - a workspace write's variables down to their names (`withoutEnvValues`, sessions/workspace-write-card-values.ts).
 *     The Web card shows the values while the card asks, because only the owner's clients read `approval.input`;
 *     a Feishu card is stored on Feishu's servers, so it never carries them;
 *   - credential shapes replaced by `[redacted]` (`redactSecrets`, common/secret-redaction.ts).
 */
export function toolInputPreview(toolName: string, input: unknown): string {
  const shown = holdsWorkspaceWriteValues(toolName) ? withoutEnvValues(input) : input;
  return redactSecrets(JSON.stringify(shown ?? {}, null, 2) ?? '{}').text;
}
