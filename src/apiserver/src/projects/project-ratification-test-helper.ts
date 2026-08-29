/**
 * Establish the real owner-ratification precondition in PostgreSQL integration fixtures.
 *
 * This helper is deliberately test-only in name and call sites. It spends the pending owner CTA
 * as the fixture's owner; it does not insert a ratification row or disable the production guard.
 */
type Query = <T extends Record<string, unknown>>(
  sql: string,
  values: readonly unknown[],
) => Promise<T[]>;

async function ratify(
  query: Query,
  ownerId: string,
  projectId: string,
  label: string,
): Promise<Record<string, unknown>> {
  // Older fixtures predate structured Project acceptance, but the production ratification
  // boundary correctly refuses an empty semantic contract. Give only those fixtures a real,
  // explicit goal and criterion before asking that boundary to decide; existing declarations are
  // never replaced.
  await query(
    `UPDATE "project"
        SET "goal" = $3, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = $2::uuid AND "owner_id" = $1::uuid
        AND NULLIF(btrim(COALESCE("goal", '')), '') IS NULL`,
    [ownerId, projectId, `Exercise the ${label} production integration boundary`],
  );
  await query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id", "project_id", "ordinal", "text", "verification_method",
       "completion_criterion", "content_hash", "semantic_hash", "evaluation_plan_hash"
     )
     SELECT gen_random_uuid(), $2::uuid, 1, $3, $4, 'HUMAN_SIGNOFF',
            encode(digest('combined:' || $2::text || ':' || $3, 'sha256'), 'hex'),
            encode(digest('semantic:' || $2::text || ':' || $3, 'sha256'), 'hex'),
            encode(digest('evaluation:' || $2::text || ':' || $4, 'sha256'), 'hex')
      WHERE EXISTS (
        SELECT 1 FROM "project" WHERE "id" = $2::uuid AND "owner_id" = $1::uuid
      ) AND NOT EXISTS (
        SELECT 1 FROM "project_acceptance_criterion_definition" WHERE "project_id" = $2::uuid
      )`,
    [
      ownerId,
      projectId,
      `The ${label} integration behavior remains correct`,
      `Execute the real PostgreSQL ${label} fixture and its assertions`,
    ],
  );
  const [observed] = await query<{ state: Record<string, unknown> }>(
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS state',
    [ownerId, projectId],
  );
  let state = observed?.state;
  if (!state) throw new Error(`owner ratification state is absent for ${label}`);
  if (state.ratified === true) return state;

  const request = state.decisionRequest;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`owner ratification request is absent for ${label}`);
  }
  const decisionRequestId = String((request as Record<string, unknown>).id ?? '');
  const ctaToken = String((request as Record<string, unknown>).ctaToken ?? '');
  const contractDigest = String(state.contractDigest ?? '');
  if (!decisionRequestId || !ctaToken || !contractDigest) {
    throw new Error(`owner ratification request is incomplete for ${label}`);
  }
  const [decided] = await query<{ result: Record<string, unknown> }>(
    `SELECT project_owner_ratify_contract(
       $1::uuid,$2::uuid,'OWNER',$1::text,$3,$4::uuid,$5::uuid,'APPROVE',$6,false
     ) AS result`,
    [
      ownerId,
      projectId,
      contractDigest,
      decisionRequestId,
      ctaToken,
      `pg-test-owner-ratification:${label}:${projectId}`,
    ],
  );
  if (decided?.result?.ok !== true) {
    throw new Error(`owner ratification failed for ${label}: ${JSON.stringify(decided?.result)}`);
  }
  [state] = (await query<{ state: Record<string, unknown> }>(
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS state',
    [ownerId, projectId],
  )).map((row) => row.state);
  if (!state || state.ratified !== true) {
    throw new Error(`owner ratification did not become effective for ${label}`);
  }
  return state;
}

export function ratifyProjectForPgTest(
  db: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  ownerId: string,
  projectId: string,
  label: string,
): Promise<Record<string, unknown>> {
  return ratify(
    async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[]) =>
      db.$queryRawUnsafe<T[]>(sql, ...values),
    ownerId,
    projectId,
    label,
  );
}

export function ratifyProjectWithPgClientForTest(
  db: { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> },
  ownerId: string,
  projectId: string,
  label: string,
): Promise<Record<string, unknown>> {
  return ratify(
    async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[]) =>
      (await db.query<T>(sql, [...values])).rows,
    ownerId,
    projectId,
    label,
  );
}
