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
exports.SetSessionTagsDto = exports.UpdateSessionTagDto = exports.CreateSessionTagDto = void 0;
const class_validator_1 = require("class-validator");
const public_id_1 = require("../common/public-id");
// A #RRGGBB hex color from the shared palette (the picker only offers palette swatches; the
// server just enforces the format so a stray value can't land in the column).
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
class CreateSessionTagDto {
    name;
    color;
}
exports.CreateSessionTagDto = CreateSessionTagDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(40),
    __metadata("design:type", String)
], CreateSessionTagDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(HEX_COLOR, { message: 'color must be a #RRGGBB hex' }),
    __metadata("design:type", String)
], CreateSessionTagDto.prototype, "color", void 0);
class UpdateSessionTagDto {
    name;
    color;
}
exports.UpdateSessionTagDto = UpdateSessionTagDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(40),
    __metadata("design:type", String)
], UpdateSessionTagDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(HEX_COLOR, { message: 'color must be a #RRGGBB hex' }),
    __metadata("design:type", String)
], UpdateSessionTagDto.prototype, "color", void 0);
// Replace the full set of tags on a session (the picker sends the current selection). Idempotent.
class SetSessionTagsDto {
    tagIds;
}
exports.SetSessionTagsDto = SetSessionTagsDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayUnique)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], SetSessionTagsDto.prototype, "tagIds", void 0);
//# sourceMappingURL=dto.js.map