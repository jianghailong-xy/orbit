type JsonRecord = Record<string, unknown>;

export type JudgmentEvidenceFallbackReason =
  | 'MISSING_VERSION'
  | 'UNSUPPORTED_VERSION'
  | 'UNRECOGNIZED_V1_SHAPE'
  | 'INCOMPLETE_CRITERIA';

export interface JudgmentEvidenceCommand {
  id: string;
  label: string | null;
  command: string;
  exitCode: number | string | null;
  keyOutput: string | null;
  fullOutput: string | null;
}

export interface JudgmentEvidenceArtifact {
  id: string;
  title: string;
  facts: Array<{ label: string; value: string }>;
}

export interface JudgmentEvidenceCriterion {
  key: string;
  ordinal: number;
  text: string;
  submitterConclusion: string;
  submitterClaimsPass: boolean;
  finding: string | null;
  commands: JudgmentEvidenceCommand[];
  artifacts: JudgmentEvidenceArtifact[];
}

export type JudgmentEvidencePresentation =
  | {
      kind: 'SUPPORTED';
      schema: 'TASK_COMPLETION_EVIDENCE_V1';
      criteria: JudgmentEvidenceCriterion[];
    }
  | {
      kind: 'FALLBACK';
      reason: JudgmentEvidenceFallbackReason;
      version: string | null;
    };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function outputPreview(value: string): string {
  const lines = value.split(/\r?\n/);
  const linePreview = lines.slice(0, 8).join('\n');
  const clipped = linePreview.length > 800 ? linePreview.slice(0, 800) : linePreview;
  return lines.length > 8 || linePreview.length > 800 ? `${clipped}\n…` : clipped;
}

function parseCommand(value: unknown, fallbackId: string): JudgmentEvidenceCommand | null {
  const item = record(value);
  if (!item) return null;
  const command = nonBlank(item.command);
  if (!command) return null;
  const fullOutput = nonBlank(item.rawOutput)
    ?? nonBlank(item.fullOutput)
    ?? nonBlank(item.output);
  const explicitSummary = nonBlank(item.rawOutputSummary)
    ?? nonBlank(item.outputSummary)
    ?? nonBlank(item.observation)
    ?? nonBlank(item.summary);
  const exitCode = typeof item.exitCode === 'number' && Number.isFinite(item.exitCode)
    ? item.exitCode
    : nonBlank(item.exitCode);
  return {
    id: nonBlank(item.id) ?? fallbackId,
    label: nonBlank(item.label) ?? nonBlank(item.name) ?? nonBlank(item.phase),
    command,
    exitCode,
    keyOutput: explicitSummary ?? (fullOutput ? outputPreview(fullOutput) : null),
    fullOutput,
  };
}

const ARTIFACT_FACTS: Array<[keyof JsonRecord, string]> = [
  ['path', '路径'],
  ['sha256', 'SHA-256'],
  ['digest', 'digest'],
  ['commitSha', 'commit'],
  ['branch', 'branch'],
  ['subject', '说明'],
  ['url', '链接'],
  ['size', '大小'],
];

function parseArtifact(value: unknown, fallbackId: string): JudgmentEvidenceArtifact | null {
  if (typeof value === 'string' && value.trim()) {
    return { id: fallbackId, title: value, facts: [] };
  }
  const item = record(value);
  if (!item) return null;
  const id = nonBlank(item.id) ?? nonBlank(item.name) ?? nonBlank(item.path) ?? fallbackId;
  const title = nonBlank(item.name)
    ?? nonBlank(item.title)
    ?? nonBlank(item.path)
    ?? nonBlank(item.subject)
    ?? id;
  const facts = ARTIFACT_FACTS.flatMap(([key, label]) => {
    const valueText = scalar(item[key]);
    return valueText === null ? [] : [{ label, value: valueText }];
  });
  return { id, title, facts };
}

function collectCommands(evidence: JsonRecord): Map<string, JudgmentEvidenceCommand> {
  const commands = new Map<string, JudgmentEvidenceCommand>();
  for (const [source, values] of [
    ['commands', evidence.commands],
    ['verification', evidence.verification],
    ['checks', evidence.checks],
  ] as const) {
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      const command = parseCommand(value, `${source}-${index + 1}`);
      if (command && !commands.has(command.id)) commands.set(command.id, command);
    });
  }
  return commands;
}

function collectArtifacts(evidence: JsonRecord): Map<string, JudgmentEvidenceArtifact> {
  const artifacts = new Map<string, JudgmentEvidenceArtifact>();
  const values = [
    ...(Array.isArray(evidence.artifacts) ? evidence.artifacts : []),
    ...(evidence.artifact === undefined ? [] : [evidence.artifact]),
  ];
  values.forEach((value, index) => {
    const artifact = parseArtifact(value, `artifact-${index + 1}`);
    if (artifact && !artifacts.has(artifact.id)) artifacts.set(artifact.id, artifact);
  });
  return artifacts;
}

function conclusion(item: JsonRecord): { value: string; pass: boolean } | null {
  if (typeof item.satisfied === 'boolean') {
    return item.satisfied
      ? { value: 'PASS', pass: true }
      : { value: 'NOT_SATISFIED', pass: false };
  }
  const value = nonBlank(item.submitterConclusion)
    ?? nonBlank(item.result)
    ?? nonBlank(item.verdict)
    ?? nonBlank(item.conclusion);
  if (!value) return null;
  return { value, pass: value.trim().toUpperCase() === 'PASS' };
}

function criterionFinding(item: JsonRecord): string | null {
  return nonBlank(item.finding)
    ?? nonBlank(item.explanation)
    ?? nonBlank(item.proof)
    ?? nonBlank(item.summary);
}

interface CriterionSource {
  item: JsonRecord;
  ordinal: number;
  text: string;
}

function criterionSources(evidence: JsonRecord): CriterionSource[] | null {
  const canonical = Array.isArray(evidence.criteria) ? evidence.criteria : null;
  if (canonical) {
    const result: CriterionSource[] = [];
    for (const [index, value] of canonical.entries()) {
      const item = record(value);
      if (!item) return null;
      const text = nonBlank(item.text) ?? nonBlank(item.criterionText) ?? nonBlank(item.criterion);
      if (!text) return null;
      result.push({ item, ordinal: integer(item.ordinal) ?? index + 1, text });
    }
    return result.length ? result : null;
  }

  const mapped = Array.isArray(evidence.acceptanceCriteria) ? evidence.acceptanceCriteria : null;
  if (!mapped?.length) return null;
  const mappedRecords = mapped.map(record);
  if (mappedRecords.some((item) => item === null)) return null;

  const selfDescribing = mappedRecords.every((item) => (
    nonBlank(item!.text) || nonBlank(item!.criterionText) || nonBlank(item!.criterion)
  ));
  if (selfDescribing) {
    return mappedRecords.map((item, index) => ({
      item: item!,
      ordinal: integer(item!.ordinal) ?? integer(item!.number) ?? index + 1,
      text: nonBlank(item!.text) ?? nonBlank(item!.criterionText) ?? nonBlank(item!.criterion)!,
    }));
  }

  // N13's v1 form deliberately carried the immutable criterion strings as an array and linked
  // every conclusion to one string by ordinal. This is structured identity, not a parser over the
  // task's acceptanceCriteria prose.
  const task = record(evidence.task);
  const snapshot = task && Array.isArray(task.criterionSnapshot)
    ? task.criterionSnapshot
    : null;
  if (!snapshot?.length || snapshot.some((item) => !nonBlank(item))) return null;
  const byOrdinal = new Map<number, JsonRecord>();
  for (const item of mappedRecords as JsonRecord[]) {
    const ordinal = integer(item.ordinal) ?? integer(item.number);
    if (!ordinal || ordinal > snapshot.length || byOrdinal.has(ordinal)) return null;
    byOrdinal.set(ordinal, item);
  }
  if (byOrdinal.size !== snapshot.length) return null;
  return snapshot.map((text, index) => ({
    item: byOrdinal.get(index + 1)!,
    ordinal: index + 1,
    text: text as string,
  }));
}

function referencedIds(item: JsonRecord, names: string[]): string[] {
  return [...new Set(names.flatMap((name) => stringList(item[name])))];
}

/**
 * Deterministically adapt only explicitly versioned, structurally self-describing evidence.
 * Acceptance-criteria prose is intentionally not an input: if the immutable evidence payload did
 * not carry criterion boundaries and texts, the caller receives a safe audit-only fallback.
 */
export function adaptJudgmentEvidence(value: unknown): JudgmentEvidencePresentation {
  const evidence = record(value);
  if (!evidence) return { kind: 'FALLBACK', reason: 'MISSING_VERSION', version: null };
  const version = scalar(evidence.schemaVersion);
  if (version === null) return { kind: 'FALLBACK', reason: 'MISSING_VERSION', version: null };
  if (evidence.schemaVersion !== 1) {
    return { kind: 'FALLBACK', reason: 'UNSUPPORTED_VERSION', version };
  }
  if (evidence.kind !== 'TASK_COMPLETION_EVIDENCE') {
    return { kind: 'FALLBACK', reason: 'UNRECOGNIZED_V1_SHAPE', version };
  }

  const sources = criterionSources(evidence);
  if (!sources) {
    return { kind: 'FALLBACK', reason: 'UNRECOGNIZED_V1_SHAPE', version };
  }
  const topCommands = collectCommands(evidence);
  const topArtifacts = collectArtifacts(evidence);
  const criteria: JudgmentEvidenceCriterion[] = [];
  for (const source of sources) {
    const claimed = conclusion(source.item);
    if (!claimed) {
      return { kind: 'FALLBACK', reason: 'INCOMPLETE_CRITERIA', version };
    }
    const key = nonBlank(source.item.id) ?? `criterion-${source.ordinal}`;
    const commandRefs = referencedIds(source.item, ['commandIds', 'commandRefs', 'evidenceRefs']);
    const artifactRefs = referencedIds(source.item, ['artifactIds', 'artifactRefs', 'evidenceRefs']);
    const commands = commandRefs.flatMap((id) => topCommands.get(id) ?? []);
    if (Array.isArray(source.item.commands)) {
      source.item.commands.forEach((value, index) => {
        const command = parseCommand(value, `${key}-command-${index + 1}`);
        if (command) commands.push(command);
      });
    }
    const artifacts = artifactRefs.flatMap((id) => topArtifacts.get(id) ?? []);
    if (Array.isArray(source.item.artifacts)) {
      source.item.artifacts.forEach((value, index) => {
        const artifact = parseArtifact(value, `${key}-artifact-${index + 1}`);
        if (artifact) artifacts.push(artifact);
      });
    }
    criteria.push({
      key,
      ordinal: source.ordinal,
      text: source.text,
      submitterConclusion: claimed.value,
      submitterClaimsPass: claimed.pass,
      finding: criterionFinding(source.item),
      commands,
      artifacts,
    });
  }
  return { kind: 'SUPPORTED', schema: 'TASK_COMPLETION_EVIDENCE_V1', criteria };
}
