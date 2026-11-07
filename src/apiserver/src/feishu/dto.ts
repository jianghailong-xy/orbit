import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import {
  FEISHU_APP_ID_MAX_LENGTH,
  FEISHU_CHAT_ALLOWED_MAX,
  FEISHU_CHAT_MAX_CONCURRENT_LIMIT,
  FEISHU_CHAT_SESSIONS_PER_DAY_LIMIT,
  FEISHU_APP_SECRET_MAX_LENGTH,
  FEISHU_MESSAGE_DETAILS,
  FEISHU_PLATFORMS,
  type FeishuAdminChange,
  type FeishuAppChange,
  type FeishuAppConnect,
  type FeishuChatChange,
  type FeishuChatConfirm,
  type FeishuMessageDetail,
  type FeishuPlatform,
  PermissionMode,
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

/** An open_id as Feishu writes one. */
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;

/** `POST /integrations/feishu/chats/confirm`: the group a ticket names, connected with the owner's choices (§8.1). */
export class ConfirmFeishuChatDto implements FeishuChatConfirm {
  @IsString()
  @MaxLength(128)
  ticket!: string;

  @IsPublicId()
  workspaceId!: string;

  @IsEnum(PermissionMode)
  permissionMode!: PermissionMode;

  @IsArray()
  @ArrayMaxSize(FEISHU_CHAT_ALLOWED_MAX)
  @Matches(OPEN_ID, { each: true, message: 'each allowed sender must be a Feishu open_id (ou_…)' })
  allowedOpenIds!: string[];

  @IsInt()
  @Min(1)
  @Max(FEISHU_CHAT_MAX_CONCURRENT_LIMIT)
  maxConcurrentSessions!: number;

  @IsInt()
  @Min(1)
  @Max(FEISHU_CHAT_SESSIONS_PER_DAY_LIMIT)
  sessionsPerDay!: number;
}

/** `PATCH /integrations/feishu/chats/:id`: switch a connected group off or on, or change what it was confirmed with. */
export class ChangeFeishuChatDto implements FeishuChatChange {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(PermissionMode)
  permissionMode?: PermissionMode;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FEISHU_CHAT_ALLOWED_MAX)
  @Matches(OPEN_ID, { each: true, message: 'each allowed sender must be a Feishu open_id (ou_…)' })
  allowedOpenIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FEISHU_CHAT_MAX_CONCURRENT_LIMIT)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FEISHU_CHAT_SESSIONS_PER_DAY_LIMIT)
  sessionsPerDay?: number;
}
