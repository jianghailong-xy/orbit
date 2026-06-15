/** Minimal flag parser: supports `--key value`, `--key=value`, and boolean `--flag`. */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[body] = next;
        i++;
      } else {
        out[body] = true;
      }
    }
  }
  return out;
}

export function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = str(flags, key);
  return v !== undefined ? Number(v) : undefined;
}

export function list(flags: Record<string, string | boolean>, key: string): string[] | undefined {
  const v = str(flags, key);
  return v !== undefined ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}
