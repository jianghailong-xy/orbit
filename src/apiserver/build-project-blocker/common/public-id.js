"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var PublicIdPipe_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PublicIdPipe = void 0;
exports.IsPublicId = IsPublicId;
const common_1 = require("@nestjs/common");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const shared_1 = require("@orbit/shared");
/**
 * THE RULE, in one place: every id a caller supplies is a *public id* — either the base62 short
 * form the clients put in URLs (`/sessions/343dlzsYWKo5z8l2M8tsB`) or the raw UUID. Both resolve
 * to the UUID the `@db.Uuid` columns key by; anything else is a 400 that names the field.
 *
 * Without it the id reaches Prisma as-is and a caller who pasted a link gets a bare 500 —
 * P2023 `Inconsistent column data`, or `invalid input syntax for type uuid` from the raw-SQL
 * list queries — with nothing to act on.
 *
 * Why this is DECLARED at each id rather than inferred globally from the field name: the wire
 * is full of id-named fields that are not public ids and would break if normalized —
 * `clientTurnId` (a free-form idempotency key), `toolUseId` (`toolu_01…`), `bundleId`
 * (`com.orbit.ios`), `operationId` / `requestId` (opaque attempt tokens), `limitId` (a Codex
 * rate-limit bucket name), `runtimeSessionId` / `claudeSessionId` (the engine's own id). Several
 * ride the runner protocol, where a wrong 400 would break already-installed runners.
 *
 * One class covers all three positions, and which one it is decides required-vs-optional — so
 * the distinction can't be got wrong by reaching for the wrong pipe:
 *   `@Param('id', PublicIdPipe)`                     — required; an empty segment is a 400
 *   `@Query('workspaceId', PublicIdPipe)`                — optional; absent stays absent
 *   `@Body(PublicIdPipe.forFields('workspaceId')) dto: T`    — for bodies class-validator never sees
 * DTO *classes* declare it as a field decorator instead: `@IsPublicId()`.
 */
let PublicIdPipe = PublicIdPipe_1 = class PublicIdPipe {
    /** Body field names to normalize; unset for a scalar param/query.
     *
     *  Deliberately NOT a constructor parameter. `@Param('id', PublicIdPipe)` hands Nest the
     *  CLASS, and Nest instantiates it through the DI container — a constructor arg there is a
     *  dependency it must resolve, so a `string[]` parameter makes every route using the class
     *  form fail at boot with "can't resolve dependencies of the PublicIdPipe (?)". Keeping the
     *  constructor empty is what lets one class serve both forms. */
    fields;
    /** Values this pipe hands through untouched instead of decoding — see `allowing`. */
    sentinels;
    /** Body form: `@Body(PublicIdPipe.forFields('workspaceId'))`. */
    static forFields(...fields) {
        const pipe = new PublicIdPipe_1();
        pipe.fields = fields;
        return pipe;
    }
    /** Query form for a filter that also has non-id sentinel values:
     *  `@Query('listId', PublicIdPipe.allowing('none'))`.
     *
     *  Base62's alphabet is every alnum, so a word-shaped sentinel is itself a *valid* public id —
     *  it decodes to a uuid nothing is filed under rather than throwing. `?listId=none` ("tasks in
     *  no list") became `00000000-0000-0000-0000-000000b52c46`, so the endpoint answered empty and
     *  the sidebar bucket that is the only way into those tasks stopped rendering. A sentinel has to
     *  be declared here, at the decode, because downstream it is indistinguishable from a real id. */
    static allowing(...sentinels) {
        const pipe = new PublicIdPipe_1();
        pipe.sentinels = new Set(sentinels);
        return pipe;
    }
    transform(value, metadata) {
        if (this.fields)
            return this.normalizeFields(value);
        // A route param is part of the address: `undefined` here would reach Prisma as "no filter"
        // and match an arbitrary row, so an empty one has to be refused. A query is a filter, and
        // an absent filter is a legitimate request for the unfiltered list.
        if (!isPresent(value)) {
            if (metadata?.type === 'query')
                return undefined;
            throw new common_1.BadRequestException(`invalid ${metadata?.data ?? 'id'}`);
        }
        if (this.sentinels?.has(value))
            return value;
        return resolve(value, metadata?.data);
    }
    /** Only the listed fields are touched, so this adds no whitelisting the DTO didn't ask for
     *  and can't silently drop a field an older client still sends. */
    normalizeFields(body) {
        if (!body || typeof body !== 'object')
            return body;
        const record = body;
        for (const field of this.fields) {
            const value = record[field];
            if (Array.isArray(value)) {
                record[field] = value.map((item) => resolve(item, field));
            }
            else if (isPresent(value)) {
                record[field] = resolve(value, field);
            }
        }
        return body;
    }
};
exports.PublicIdPipe = PublicIdPipe;
exports.PublicIdPipe = PublicIdPipe = PublicIdPipe_1 = __decorate([
    (0, common_1.Injectable)()
], PublicIdPipe);
/** The same rule bound for class-validator, for the DTO classes the global ValidationPipe does
 *  see. Normalizes first, then validates; an undecodable value is left alone so `@IsUUID`
 *  reports it with its usual message. */
function IsPublicId(options) {
    const normalize = (value) => {
        if (typeof value !== 'string')
            return value;
        try {
            return (0, shared_1.toUuid)(value);
        }
        catch {
            return value;
        }
    };
    return (0, common_1.applyDecorators)((0, class_transformer_1.Transform)(({ value }) => (Array.isArray(value) ? value.map(normalize) : normalize(value))), (0, class_validator_1.IsUUID)('all', options));
}
function isPresent(value) {
    return typeof value === 'string' && value.trim() !== '';
}
function resolve(value, field) {
    try {
        return (0, shared_1.toUuid)(value);
    }
    catch {
        throw new common_1.BadRequestException(`invalid ${field ?? 'id'}`);
    }
}
//# sourceMappingURL=public-id.js.map