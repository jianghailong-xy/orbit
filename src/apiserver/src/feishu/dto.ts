import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import {
  FEISHU_APP_ID_MAX_LENGTH,
  FEISHU_APP_SECRET_MAX_LENGTH,
  FEISHU_MESSAGE_DETAILS,
  FEISHU_PLATFORMS,
  type FeishuAdminChange,
  type FeishuAppChange,
  type FeishuAppConnect,
  type FeishuMessageDetail,
  type FeishuPlatform,
} from '@orbit/shared';
import { IsPublicId } from '../common/public-id';

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

  @IsOptional()
  @IsIn(FEISHU_MESSAGE_DETAILS)
  messageDetail?: FeishuMessageDetail;

  /** Where the owner's new direct messages open a session (§7.3); null clears it. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsPublicId()
  defaultWorkspaceId?: string | null;
}

/** `PUT /admin/integrations/feishu`: "Allow accounts to connect Feishu bots". */
export class SetFeishuAdminDto implements FeishuAdminChange {
  @IsBoolean()
  allowed!: boolean;
}
