// Protocol fixture: an additive, literal system section; leaves Harness defaults intact.
export const name = 'orbit-p0-append-prompt';
export const inject = ['systemPrompt'];
export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'orbit:append-system-prompt', order: 10201,
    text: config.text, interpolate: false });
}
