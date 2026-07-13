import { ArrayUnique, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// A #RRGGBB hex color from the shared palette (the picker only offers palette swatches; the
// server just enforces the format so a stray value can't land in the column).
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export class CreateSessionTagDto {
  @IsString() @MinLength(1) @MaxLength(40) name!: string;
  @IsString() @Matches(HEX_COLOR, { message: 'color must be a #RRGGBB hex' }) color!: string;
}

export class UpdateSessionTagDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'color must be a #RRGGBB hex' }) color?: string;
}

// Replace the full set of tags on a session (the picker sends the current selection). Idempotent.
export class SetSessionTagsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) tagIds!: string[];
}
