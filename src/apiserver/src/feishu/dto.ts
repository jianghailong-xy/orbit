import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  FEISHU_APP_ID_MAX_LENGTH,
  FEISHU_APP_SECRET_MAX_LENGTH,
  FEISHU_PLATFORMS,
  type FeishuAdminChange,
  type FeishuAppChange,
  type FeishuAppConnect,
  type FeishuPlatform,
} from '@orbit/shared';

/** `PUT /integrations/feishu`: the whole app, its secret included (docs/feishu-bot-design.md §4.1). */
export class ConnectFeishuAppDto implements FeishuAppConnect {
  @IsIn(FEISHU_PLATFORMS)
  platform!: FeishuPlatform;

  @IsString()
  @MaxLength(FEISHU_APP_ID_MAX_LENGTH)
  appId!: string;

  @IsString()
  @MaxLength(FEISHU_APP_SECRET_MAX_LENGTH)
  appSecret!: string;
}

/** `PATCH /integrations/feishu`: what an account changes on the app it has. */
export class ChangeFeishuAppDto implements FeishuAppChange {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `PUT /admin/integrations/feishu`: "Allow accounts to connect Feishu bots". */
export class SetFeishuAdminDto implements FeishuAdminChange {
  @IsBoolean()
  allowed!: boolean;
}
