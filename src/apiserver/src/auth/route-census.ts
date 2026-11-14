import { type DynamicModule } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../app.module';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * The route censuses' shared walk (pat-route-coverage.spec.ts, terminal-route-coverage.spec.ts): the controllers the
 * production app mounts, read the way Nest mounts them — AppModule's imports followed all the way down — and each
 * controller's handlers as Nest's route explorer finds them. Test-only; nothing in the app imports it.
 */
export type Controller = new (...args: never[]) => unknown;

/** Every controller the production app mounts. */
export async function mountedControllers(): Promise<Set<Controller>> {
  const seen = new Set<unknown>();
  const controllers = new Set<Controller>();
  const visit = async (entry: unknown): Promise<void> => {
    // `ConfigModule.forRoot()` is a promise of its module; `forwardRef(() => X)` names one lazily.
    let node = await entry;
    if (node && typeof node === 'object' && 'forwardRef' in node) node = (node as { forwardRef: () => unknown }).forwardRef();
    if (!node || seen.has(node)) return;
    seen.add(node);
    const dynamic = typeof node === 'object' ? (node as DynamicModule) : undefined;
    const declared = (key: string) => (Reflect.getMetadata(key, dynamic ? dynamic.module : (node as object)) ?? []) as unknown[];
    for (const c of [...declared(MODULE_METADATA.CONTROLLERS), ...(dynamic?.controllers ?? [])]) controllers.add(c as Controller);
    for (const i of [...declared(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) await visit(i);
  };
  await visit(AppModule);
  return controllers;
}

export const isJwtAuthGuard = (guard: unknown) => guard === JwtAuthGuard || guard instanceof JwtAuthGuard;
export const guardsOf = (target: object) => (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];

/** A controller's handlers, inherited ones included, as Nest's route explorer finds them. */
export function handlersOf(controller: Controller): Array<[string, (...args: unknown[]) => unknown]> {
  const found = new Map<string, (...args: unknown[]) => unknown>();
  for (let proto = controller.prototype as object; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
      if (name === 'constructor' || found.has(name) || typeof value !== 'function') continue;
      if (Reflect.getMetadata(METHOD_METADATA, value) === undefined) continue;
      found.set(name, value);
    }
  }
  return [...found];
}

export const join = (...parts: string[]) => '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
