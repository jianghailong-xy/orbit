import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

test.describe('controlled loading', () => {
  test.use({ scenario: 'projects-loading' });
  test('projects loading and release', async ({ evidence }) => {
    const { page, capture, api } = evidence;
    await page.goto(PATHS.projects);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search projects' })).toBeEnabled();
    await expect(page.locator('.project-row')).toHaveCount(0);
    const loading = page.locator('main [aria-busy="true"]');
    await expect(loading).toBeVisible();
    await capture('projects-loading', { loading });
    api.release();
    await expect(page.locator('.project-row')).toHaveCount(1);
  });
});

test.describe('controlled error', () => {
  test.use({ scenario: 'projects-error' });
  test('projects error and retry', async ({ evidence }) => {
    const { page, capture, api } = evidence;
    await page.goto(PATHS.projects);
    await expect(page.getByText('Projects could not be loaded', { exact: true })).toBeVisible();
    await expect(page.getByText('Fixture project load failed', { exact: true })).toBeVisible();
    await capture('projects-error', { retry: page.getByRole('button', { name: 'Retry', exact: true }) });
    const before = api.requests.filter((request) => request.path === '/api/projects').length;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => api.requests.filter((request) => request.path === '/api/projects').length).toBeGreaterThan(before);
    await expect(page.getByText('Projects could not be loaded', { exact: true })).toBeVisible();
  });
});
