import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Orbit's copy is English: every word a client draws, and every word the server or a runner writes
 * for a person or an agent to read. The owner made the web's copy English on 2026-06-21 (7a5215cf6),
 * and nothing held it there — Chinese came back with work built from Chinese design boards (the wake
 * line's 任务详情 ›, 2026-10-04) and was then pinned on every client by the parity tests.
 *
 * So every product source file is read here and its string literals counted, comments skipped: TS
 * and TSX through vite's parser (JSX text included; regex literals are exempt, since a pattern
 * matches what it is given and is never drawn), Swift, Kotlin and Go through the lexer below. A file
 * may hold Chinese only when ALLOWED lists it, and then exactly as many literals as it says — so a
 * new Chinese label fails here, and so does a file that dropped some without lowering its count.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Where product code lives. Tests, fixtures and scripts are not product code. */
const ROOTS = [
  'src/web/src',
  'src/shared/src',
  'src/apiserver/src',
  'src/runner-go',
  'src/macos/OrbitApp/Sources',
  'src/macos/OrbitKit/Sources',
  'src/ios/Sources',
  'src/android',
];
const SKIP_DIRS = new Set([
  'node_modules', 'build', 'dist', 'testdata', 'test', 'tests', 'Tests', '__tests__', '__fixtures__',
  'test-support', 'androidTest', 'scripts',
]);
const SOURCE = /\.(tsx?|swift|kt|go)$/;
const NOT_PRODUCT = /(\.(test|spec)\.tsx?|\.fixtures?\.tsx?|_test\.go)$/;

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const OLD_NOTES = 'parses what the control plane writes into a transcript; old transcripts hold it in Chinese';
const OWNER_WORDS = 'recognizes what the owner writes, in Chinese as well as English';
const TO_ENGLISH = 'still Chinese: being converted to English (owner, 2026-10-09); drop the entry when it is';

/** The files that may hold Chinese, with how many literals and why. */
const ALLOWED: Record<string, [count: number, why: string]> = {
  'src/web/src/lib/backgroundWake.ts': [1, OLD_NOTES],
  'src/web/src/lib/referencedTask.ts': [4, OLD_NOTES],
  'src/macos/OrbitKit/Sources/OrbitKit/App/BackgroundWake.swift': [9, OLD_NOTES],
  'src/macos/OrbitKit/Sources/OrbitKit/Transcript/BackgroundJobs.swift': [7, OLD_NOTES],
  'src/macos/OrbitKit/Sources/OrbitKit/Transcript/ReferencedTask.swift': [7, OLD_NOTES],
  'src/android/core/src/main/kotlin/io/orbitd/android/core/cards/WakeCards.kt': [9, OLD_NOTES],
  'src/apiserver/src/tasks/task-criterion-shape-advice.ts': [10, OWNER_WORDS],
  'src/web/src/lib/wikiArticles.ts': [1, 'sorts Chinese titles by their pinyin initials'],

  // Session titles, system comments on the task timeline, and the task-list notes.
  'src/apiserver/src/tasks/tasks.service.ts': [41, TO_ENGLISH],
  'src/apiserver/src/task-lists/task-lists.service.ts': [13, TO_ENGLISH],
  'src/apiserver/src/task-lists/list-events.service.ts': [11, TO_ENGLISH],
  'src/apiserver/src/tasks/reclaim-stalled-task.ts': [20, TO_ENGLISH],
  'src/apiserver/src/tasks/task-dispatch-refusal.ts': [13, TO_ENGLISH],
  'src/apiserver/src/projects/attempt-ended-unsettled.producer.ts': [13, TO_ENGLISH],
  'src/apiserver/src/runner-api/integration-job-relay.ts': [23, TO_ENGLISH],
  'src/apiserver/src/tasks/owner-confirmation-review-turn.ts': [3, TO_ENGLISH],
  'src/apiserver/src/tasks/moved-task-evidence.ts': [54, TO_ENGLISH],

  // The coordinator's judgment turn.
  'src/apiserver/src/projects/coordinator-judgment-opening.ts': [312, TO_ENGLISH],

  // The coordinator's opening, open items and wake dispositions.
  'src/apiserver/src/projects/coordinator-opening.ts': [68, TO_ENGLISH],
  'src/apiserver/src/projects/project-open-item.ts': [231, TO_ENGLISH],
  'src/apiserver/src/projects/wake-disposition.service.ts': [8, TO_ENGLISH],

  // The task brief and the notes delivered into sessions.

  // The wiki: its topics, the prompts that write it and the prose it writes, on the server and the runner.
  'src/shared/src/wikiArticles.ts': [20, TO_ENGLISH],
  'src/shared/src/wikiPlan.ts': [2, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-articles-job.ts': [1, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-articles-writer.ts': [8, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-docs-build-job.ts': [1, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-docs-writer.ts': [72, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-maintain-job.ts': [2, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-maintain-plan.ts': [55, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-maintain.ts': [1, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-draft-job.ts': [5, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-format.ts': [74, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-gate.ts': [7, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-materials.ts': [40, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-prompts.ts': [93, TO_ENGLISH],
  'src/apiserver/src/wiki-worker/wiki-plan-repo.ts': [25, TO_ENGLISH],
  'src/runner-go/wiki_articles.go': [7, TO_ENGLISH],
  'src/runner-go/wiki_docs_build.go': [68, TO_ENGLISH],
  'src/runner-go/wiki_maintain.go': [1, TO_ENGLISH],
  'src/runner-go/wiki_maintain_docs.go': [43, TO_ENGLISH],
  'src/runner-go/wiki_plan_draft.go': [6, TO_ENGLISH],
  'src/runner-go/wiki_plan_format.go': [80, TO_ENGLISH],
  'src/runner-go/wiki_plan_gate.go': [6, TO_ENGLISH],
  'src/runner-go/wiki_plan_materials.go': [26, TO_ENGLISH],
  'src/runner-go/wiki_plan_model.go': [2, TO_ENGLISH],
  'src/runner-go/wiki_plan_prompts.go': [56, TO_ENGLISH],
  'src/runner-go/wiki_plan_repo.go': [22, TO_ENGLISH],
  'src/runner-go/wiki_repo_ops.go': [1, TO_ENGLISH],
};

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) sources(relative, found);
    } else if (entry.isFile() && SOURCE.test(entry.name) && !NOT_PRODUCT.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

/** A TS or TSX file's string literals, template pieces and JSX text — not its regex literals. */
function tsLiterals(file: string, text: string): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const { type, value } = node as { type?: unknown; value?: unknown };
    if ((type === 'Literal' || type === 'JSXText') && typeof value === 'string') found.push(value);
    if (type === 'TemplateElement') found.push((value as { raw: string }).raw);
    Object.values(node).forEach(walk);
  };
  walk(parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file));
  return found;
}

type Lang = 'swift' | 'kotlin' | 'go';

/**
 * A Swift, Kotlin or Go file's string literals, comments skipped: plain and multi-line strings,
 * Swift's raw `#"…"#`, Go's raw `` `…` `` and runes, Kotlin's chars. An interpolation (`\(…)`,
 * `${…}`) is read as code, so a string inside it is a literal of its own.
 */
function lexed(text: string, lang: Lang): string[] {
  const found: string[] = [];
  const n = text.length;

  const comment = (start: number): number => {
    let depth = 0;
    let i = start;
    while (i < n) {
      if (text.startsWith('/*', i) && (lang !== 'go' || depth === 0)) {
        depth += 1;
        i += 2;
      } else if (text.startsWith('*/', i)) {
        depth -= 1;
        i += 2;
        if (depth === 0) return i;
      } else {
        i += 1;
      }
    }
    return n;
  };

  // Code from `start` up to the `close` that ends an interpolation, or to the end of the file.
  const code = (start: number, close: ')' | '}' | null): number => {
    const open = close === ')' ? '(' : '{';
    let depth = 0;
    let i = start;
    while (i < n) {
      const c = text[i];
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i);
        i = end < 0 ? n : end;
      } else if (text.startsWith('/*', i)) {
        i = comment(i);
      } else if (c === '"' || (c === '`' && lang === 'go') || (c === "'" && lang !== 'swift')
        || (c === '#' && lang === 'swift' && /^#+"/.test(text.slice(i, i + 8)))) {
        i = literal(i);
      } else if (close && c === open) {
        depth += 1;
        i += 1;
      } else if (close && c === close) {
        if (depth === 0) return i + 1;
        depth -= 1;
        i += 1;
      } else {
        i += 1;
      }
    }
    return n;
  };

  const literal = (start: number): number => {
    let i = start;
    let hashes = '';
    while (text[i] === '#') {
      hashes += '#';
      i += 1;
    }
    const quote = text[i];
    const triple = quote === '"' && text.startsWith('"""', i);
    const closer = (triple ? '"""' : quote) + hashes;
    const escape = quote === '`' || (triple && lang === 'kotlin') ? null : `\\${hashes}`;
    let j = i + (triple ? 3 : 1);
    let body = '';
    while (j < n && !text.startsWith(closer, j)) {
      if (escape && text.startsWith(escape, j)) {
        const after = j + escape.length;
        const end = lang === 'swift' && text[after] === '(' ? code(after + 1, ')') : after + 1;
        body += text.slice(j, end);
        j = end;
      } else if (lang === 'kotlin' && text.startsWith('${', j)) {
        const end = code(j + 2, '}');
        body += text.slice(j, end);
        j = end;
      } else if (text[j] === '\n' && !triple && quote !== '`') {
        break;
      } else {
        body += text[j];
        j += 1;
      }
    }
    found.push(body);
    return text.startsWith(closer, j) ? j + closer.length : j;
  };

  code(0, null);
  return found;
}

const LANG: Record<string, Lang> = { swift: 'swift', kt: 'kotlin', go: 'go' };

/** Every product file holding Chinese in a literal, and how many such literals. */
function census(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of ROOTS.flatMap((root) => sources(root))) {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    if (!HAN.test(text)) continue;
    const extension = file.slice(file.lastIndexOf('.') + 1);
    const literals = extension === 'ts' || extension === 'tsx' ? tsLiterals(file, text) : lexed(text, LANG[extension]);
    const count = literals.filter((literal) => HAN.test(literal)).length;
    if (count > 0) counts.set(file, count);
  }
  return counts;
}

describe('copy language', () => {
  it('reads literals and skips comments in Swift, Kotlin and Go', () => {
    const chinese = (text: string, lang: Lang) => lexed(text, lang).filter((s) => HAN.test(s));
    expect(chinese('// 注释\nlet a = "x \\(f("内")) y" /* 块 /* 嵌套 */ 仍是注释 */ + #"原\\(样)"#', 'swift'))
      .toEqual(['内', 'x \\(f("内")) y', '原\\(样)']);
    expect(chinese('val a = "x ${f("内")}" // 注释\nval b = """多\n行""" + \'字\'', 'kotlin'))
      .toEqual(['内', 'x ${f("内")}', '多\n行', '字']);
    expect(chinese('a := `原 "样"` /* 注释 */ + "转\\"义"', 'go')).toEqual(['原 "样"', '转\\"义']);
  });

  it('holds Chinese only in the files ALLOWED lists, at exactly their counts', () => {
    const found = census();
    const drift: string[] = [];
    for (const [file, count] of found) {
      const allowed = ALLOWED[file]?.[0] ?? 0;
      if (count !== allowed) drift.push(`${file}: ${count} literal(s) hold Chinese, ${allowed} allowed`);
    }
    for (const [file, [allowed]] of Object.entries(ALLOWED)) {
      if (!found.has(file)) drift.push(`${file}: none hold Chinese now, ${allowed} allowed — drop its entry`);
    }
    expect(
      drift,
      'All copy is English, in every client and in what the server and runner write (AGENTS.md). Write '
        + 'the new words in English. A count that went down is a file that got more English: lower its '
        + 'entry, or drop it at zero. Only a parser of old Chinese notes, or code that recognizes what the '
        + 'owner writes, takes a new entry.',
    ).toEqual([]);
  });
});
