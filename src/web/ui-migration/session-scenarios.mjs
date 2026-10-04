import { SEND_ERROR, SESSION_PATH, STREAM_TEXT, sessionStream } from './session-fixtures.mjs';

/** Runs on the production router, with real controls and deterministic transport fixtures. */
export async function sessionScenarios({ page, expect, capture, measure }) {
  await page.goto(SESSION_PATH);
  const composer = page.locator('.composer-field textarea');
  const attach = page.getByRole('button', { name: 'Add attachment', exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByText('existing interface', { exact: true })).toBeVisible();
  await capture('session-idle', {
    composer: '.composer-field', input: composer, attachment: attach,
    userMessage: '.chat-user', assistantMessage: '.chat-assistant',
  });

  await sessionStream(page, 'start');
  await expect(page.getByText(STREAM_TEXT, { exact: true })).toBeVisible();
  await capture('session-streaming', { composer: '.composer-field', streamingMessage: '.chat-streaming-md' });
  await sessionStream(page, 'end');
  await expect(page.getByText(STREAM_TEXT, { exact: true })).toHaveCount(1);

  await measure('composer-input', async () => {
    await composer.fill('Review the migration');
    await composer.press('End');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('Keep keyboard behavior.');
    await expect(composer).toHaveValue('Review the migration\nKeep keyboard behavior.');
    await expect(composer).toBeFocused();
  });
  await capture('session-composer-focus', { input: composer, composer: '.composer-box' });

  const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: /File$/ }) });
  await measure('attachment-menu-open', async () => {
    await attach.click();
    await expect(menu).toBeVisible();
  });
  await expect(menu.getByRole('menuitem')).toHaveText(['File', 'Image', 'Shell', 'Skill', 'Command']);
  await capture('session-attachment-menu', { menu, file: menu.getByRole('menuitem', { name: /File$/ }), trigger: attach });
  // The upward phone menu overlaps the draft: close it with its own trigger first.
  await attach.click();
  await expect(menu).toBeHidden();
  await composer.click();
  await expect(composer).toBeFocused();
  await attach.click();
  const chooserPromise = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', { name: /File$/ }).click();
  const chooser = await chooserPromise;
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/attachments');
  await chooser.setFiles({ name: 'baseline-note.txt', mimeType: 'text/plain', buffer: Buffer.from('UI migration baseline attachment\n') });
  expect((await uploaded).status()).toBe(200);
  await expect(page.getByText('baseline-note.txt', { exact: true })).toBeVisible();
  await expect(page.locator('.composer-file').getByRole('img', { name: 'loading', exact: true })).toHaveCount(0);
  await expect(menu).toBeHidden();
  await capture('session-attachment-staged', { attachment: '.composer-file', input: composer });
  await page.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(page.getByText('baseline-note.txt', { exact: true })).toHaveCount(0);

  // The real send action gets a controlled service error and posts through the app's toast feed.
  await composer.fill('Trigger the recorded notification');
  const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/turns/current-work-routing'));
  await composer.press('Enter');
  expect((await sent).postDataJSON().content).toBe('Trigger the recorded notification');
  const notification = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(notification.getByText("Couldn't send the message", { exact: true })).toBeVisible();
  await expect(notification.getByText(SEND_ERROR, { exact: true })).toBeVisible();
  await expect(notification.getByRole('button', { name: 'Copy error', exact: true })).toBeVisible();
  await capture('notification-error', { notification, card: '.toast--attention', dismiss: notification.getByRole('button', { name: 'Dismiss', exact: true }) });
  await notification.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notification).toHaveCount(0);
}
