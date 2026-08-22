"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordMergeReceiptDto = void 0;
const class_validator_1 = require("class-validator");
const merge_receipt_1 = require("./merge-receipt");
const MERGE_RECEIPT_RESULT_VALUES = [...merge_receipt_1.MERGE_RECEIPT_RESULTS];
/**
 * Record one merge of this session's branch (contract §13.7).
 *
 * A class rather than an interface, unlike everything above it: this body carries object names that
 * are checked against a repository later, and a SHA that arrives malformed and is stored anyway is
 * evidence that cannot be verified — which is the one thing a receipt may not be. `recordedBy` is
 * deliberately NOT here; it is decided by which door the request came through.
 */
class RecordMergeReceiptDto {
    result;
    /** Omitted falls back to the session's own recorded branch. */
    sourceBranch;
    sourceSha;
    targetBranch;
    targetShaBefore;
    targetShaAfter;
    /** The base the source had been rebased onto when this merge was computed. Omitted means it was
     *  not rebased — the distinction decides whether the tests that passed were about this tree. */
    rebaseBaseSha;
    conflicts;
    /** The raw observation: the command, its output, the refs read. */
    detail;
    /** Supply one when the caller has a natural key; omitted derives MR4's from the merge itself. */
    idempotencyKey;
}
exports.RecordMergeReceiptDto = RecordMergeReceiptDto;
__decorate([
    (0, class_validator_1.IsIn)(MERGE_RECEIPT_RESULT_VALUES),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "result", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(400),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "sourceBranch", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "sourceSha", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(400),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "targetBranch", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "targetShaBefore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "targetShaAfter", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "rebaseBaseSha", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.MaxLength)(1024, { each: true }),
    __metadata("design:type", Array)
], RecordMergeReceiptDto.prototype, "conflicts", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], RecordMergeReceiptDto.prototype, "detail", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], RecordMergeReceiptDto.prototype, "idempotencyKey", void 0);
//# sourceMappingURL=dto.js.map