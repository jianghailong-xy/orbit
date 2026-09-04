/**
 * Give a PostgreSQL integration fixture a real completion contract.
 *
 * Older fixtures predate structured Project acceptance, so they carry neither a goal nor a
 * criterion and their completion contract is cut over an empty semantic set. Callers that need the
 * contract digests — canonical bindings, evaluator results — cannot use that. This seeds one
 * explicit goal and one criterion when they are missing, refreshes the contract, and returns its
 * digests. It never replaces a declaration a fixture made for itself.
 */
type Query = <T extends Record<string, unknown>>(
  sql: string,
  values: readonly unknown[],
) => Promise<T[]>;

export interface ProjectContractDigests extends Record<string, unknown> {
  contractDigest: string;
  evaluationPlanDigest: string;
  riskPolicyDigest: string;
  permissionDigest: string;
  budgetDigest: string;
  recipientDigest: string;
}

async function establish(
  query: Query,
  ownerId: string,
  projectId: string,
  label: string,
): Promise<ProjectContractDigests> {
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
       "content_hash", "semantic_hash", "evaluation_plan_hash"
     )
     SELECT gen_random_uuid(), $2::uuid, 1, $3, $4,
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
  await query('SELECT project_refresh_completion_contract($1::uuid, $2) AS refreshed',
    [projectId, 'PG_TEST_FIXTURE']);
  const [state] = await query<ProjectContractDigests>(
    `SELECT "contract_digest" AS "contractDigest",
            "evaluation_plan_digest" AS "evaluationPlanDigest",
            "risk_policy_digest" AS "riskPolicyDigest",
            "permission_digest" AS "permissionDigest",
            "budget_digest" AS "budgetDigest",
            "recipient_digest" AS "recipientDigest"
       FROM "project_completion_contract" WHERE "project_id" = $1::uuid`,
    [projectId],
  );
  if (!state?.contractDigest) {
    throw new Error(`completion contract is absent for ${label}`);
  }
  return state;
}

export function establishProjectContractForPgTest(
  db: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  ownerId: string,
  projectId: string,
  label: string,
): Promise<ProjectContractDigests> {
  return establish(
    async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[]) =>
      db.$queryRawUnsafe<T[]>(sql, ...values),
    ownerId,
    projectId,
    label,
  );
}

export function establishProjectContractWithPgClientForTest(
  db: { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> },
  ownerId: string,
  projectId: string,
  label: string,
): Promise<ProjectContractDigests> {
  return establish(
    async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[]) =>
      (await db.query<T>(sql, [...values])).rows,
    ownerId,
    projectId,
    label,
  );
}
