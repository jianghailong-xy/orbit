"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertCoordinatorPgUrlIsIsolated = assertCoordinatorPgUrlIsIsolated;
exports.verifyCoordinatorPgIdentity = verifyCoordinatorPgIdentity;
const strict_1 = __importDefault(require("node:assert/strict"));
let announced = false;
/**
 * Destructive coordinator PostgreSQL specs must prove their target before creating or dropping
 * anything. The explicit expected identity makes a copied production URL fail before the first
 * write; the pcc_ naming rule also rejects Orbit's shared database and role by construction.
 */
function assertCoordinatorPgUrlIsIsolated(connectionString) {
    strict_1.default.ok(connectionString, 'COORDINATOR_PG_URL is required');
    const expectedDatabase = process.env.COORDINATOR_PG_EXPECTED_DATABASE;
    const expectedUser = process.env.COORDINATOR_PG_EXPECTED_USER;
    const expectedSystemIdentifier = process.env.COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
    strict_1.default.ok(expectedDatabase, 'COORDINATOR_PG_EXPECTED_DATABASE is required for destructive PG specs');
    strict_1.default.ok(expectedUser, 'COORDINATOR_PG_EXPECTED_USER is required for destructive PG specs');
    strict_1.default.ok(expectedSystemIdentifier, 'COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER is required for destructive PG specs');
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const user = decodeURIComponent(url.username);
    // `pcc<unit>_`, where a unit is 03, 04, 03a — a repair of a unit is not the unit, and its
    // database must not be the unit's either. The prefix is the cheap half of the guard; the
    // explicit expected database, role and server identity below are the half that decides.
    strict_1.default.match(database, /^pcc[0-9a-z]*[_-]/, 'destructive coordinator specs require a dedicated pcc_* database');
    strict_1.default.match(user, /^pcc[0-9a-z]*[_-]/, 'destructive coordinator specs require a dedicated pcc_* role');
    strict_1.default.doesNotMatch(`${url.hostname}/${database}/${user}`, /orbit-postgres|(^|[\/_-])orbit([\/_-]|$)/i, 'shared Orbit PostgreSQL targets are forbidden');
    strict_1.default.equal(database, expectedDatabase, 'URL database does not match the explicitly expected isolated database');
    strict_1.default.equal(user, expectedUser, 'URL user does not match the explicitly expected isolated role');
}
/** Read-only identity probe. Call immediately after connect and before every fixture mutation. */
async function verifyCoordinatorPgIdentity(client) {
    const expectedDatabase = process.env.COORDINATOR_PG_EXPECTED_DATABASE;
    const expectedUser = process.env.COORDINATOR_PG_EXPECTED_USER;
    const expectedSystemIdentifier = process.env.COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
    const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS role,
           inet_server_addr()::text AS server_addr,
           inet_server_port() AS server_port,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS server_version
  `);
    const identity = result.rows[0];
    strict_1.default.equal(identity.database, expectedDatabase, 'connected database is not the expected isolated database');
    strict_1.default.equal(identity.role, expectedUser, 'connected role is not the expected isolated role');
    strict_1.default.equal(identity.system_identifier, expectedSystemIdentifier, 'server identity differs from the explicitly expected disposable PostgreSQL server');
    strict_1.default.doesNotMatch(`${identity.database}/${identity.role}`, /(^|[\/_-])orbit([\/_-]|$)/i, 'shared Orbit PostgreSQL identity is forbidden');
    if (!announced) {
        announced = true;
        console.log(`coordinator-pg-isolation database=${identity.database} user=${identity.role} ` +
            `server=${identity.server_addr ?? 'local'}:${identity.server_port} ` +
            `system_identifier=${identity.system_identifier} version=${identity.server_version}`);
    }
}
//# sourceMappingURL=coordinator-pg-test-safety.js.map