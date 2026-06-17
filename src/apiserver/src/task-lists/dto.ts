import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTaskListDto {
  @IsString()
  @MinLength(1)
  title!: string;
}

export class UpdateTaskListDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
}
