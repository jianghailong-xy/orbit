import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunEventType } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { onTranslationAvailabilityChange } from '../sessions/translation';

/**
 * Tells every connected client when this process's translator circuit breaker opens, opens again or closes
 * (MeTranslation.translationUnavailableUntil, @orbit/shared translation.ts), as `translation.status_changed`, so
 * they read `GET /users/me` again. The breaker is the process's, the same for every account, hence every user.
 */
@Injectable()
export class TranslationStatusAnnouncer implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(private readonly realtime: RealtimeService) {}

  onModuleInit(): void {
    this.unsubscribe = onTranslationAvailabilityChange(() =>
      this.realtime.publishForAllUsers(RunEventType.TRANSLATION_STATUS_CHANGED, 'translation'));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }
}
