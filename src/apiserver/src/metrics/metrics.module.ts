import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';

/**
 * No providers: the registry is module state in `common/db-conflict-metrics.ts`, not an injectable.
 *
 * It has to be, because the things that write to it are not services. `withTransactionRetry` is a
 * free function called from forty-odd places, several of them inside closures that only have a
 * transaction client; threading a Nest provider down to each would mean changing every call site to
 * carry something none of them otherwise needs.
 */
@Module({ controllers: [MetricsController] })
export class MetricsModule {}
