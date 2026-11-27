import type { PrismaService } from '../prisma/prisma.service';

/** Engine names as the owner reads them in the account row and the push (§8: "Cursor can't run on this account"). */
const PRODUCT: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', antigravity: 'Antigravity', cursor: 'Cursor',
};

export interface AccountSubjectNames {
  /** The push title: the runner's name, or the provider's label for a key. */
  title: string;
  /** What is refused, in the body: the engine's name, or the key's provider label. */
  product: string;
  /** The runner the account is signed in on; null for a key or a pool login. */
  runnerId: string | null;
}

/** Read a `subject_key` (§6.1) as the words the owner knows it by. Unknown parts fall back to "Orbit". */
export async function accountSubjectNames(
  db: Pick<PrismaService, 'runner' | 'modelProvider' | 'providerPool'>,
  ownerId: string,
  subjectKey: string,
): Promise<AccountSubjectNames> {
  const [type, a, b] = subjectKey.split(':');
  if (type === 'runner') {
    const runner = await db.runner.findFirst({ where: { id: a, ownerId }, select: { name: true, displayName: true } });
    return { title: runner?.displayName || runner?.name || 'Orbit', product: PRODUCT[b] ?? b ?? 'This engine', runnerId: a };
  }
  if (type === 'provider') {
    const provider = await db.modelProvider.findFirst({ where: { id: a }, select: { label: true } });
    return { title: provider?.label ?? 'Orbit', product: provider?.label ?? 'This provider', runnerId: null };
  }
  const pool = await db.providerPool.findFirst({ where: { id: a, ownerId }, select: { slug: true } });
  return { title: pool?.slug ?? 'Orbit', product: pool?.slug ?? 'This pool', runnerId: null };
}
