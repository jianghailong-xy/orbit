import { test as base } from '/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web/ui-migration/harness.mjs';
import { profileScenario } from '/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web/ui-migration/page-scenarios.mjs';

// ISO_FORCE=1: read document.documentElement.scrollHeight (a synchronous layout) right after lib/toast's
// announce() appends its body-level screen-reader region, as AntD Form.Item's offsetParent check did
// on the reference page. Nothing else changes: same build, fixtures, scenario and expected screenshots.
const test = base.extend({
  page: async ({ page }, use) => {
    if (process.env.ISO_FORCE === '1') {
      await page.addInitScript(() => {
        const append = Node.prototype.appendChild;
        Node.prototype.appendChild = function (child) {
          const result = append.call(this, child);
          if (this === document.body && child instanceof Element && child.classList.contains('sr-only')) void document.documentElement.scrollHeight;
          return result;
        };
      });
    }
    await use(page);
  },
});
test('profile', async ({ evidence }) => profileScenario(evidence));
