import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { avatarQuery, meQuery, type Me } from '../lib/queries';
import { CHOOSE_PHOTO, NAME_CAPTION, ProfilePage, REMOVE_PHOTO } from './ProfilePage';

const account: Me = { id: 'u1', email: 'owner@example.test', name: 'jianghailong.rd', createdAt: '2026-09-01' };

/** The page with the reads it makes seeded, so nothing has to be fetched. */
function render(me: Me, photo?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, me);
  if (photo) qc.setQueryData(avatarQuery(me.avatarUpdatedAt).queryKey, photo);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Profile · the photo and the name are the owner\'s to change', () => {
  it('shows the name in a field, with a Save that waits for a change', () => {
    const html = render(account);
    expect(html).toMatch(/<input[^>]*value="jianghailong\.rd"/);
    expect(html).toMatch(/<input[^>]*maxlength="80"/i); // React keeps the prop's casing
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>Save<\/span><\/button>/);
    expect(html).toContain(NAME_CAPTION);
    expect(html).toContain('owner@example.test');
  });

  it('offers a photo to an account without one, drawing the first letter meanwhile', () => {
    const html = render(account);
    expect(html).toContain(`<span>${CHOOSE_PHOTO}</span>`);
    expect(html).not.toContain(REMOVE_PHOTO);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"/);
    expect(html).toMatch(/orbit-avatar-string[^>]*>J</);
    expect(html).not.toContain('<img');
  });

  it('draws the photo an account has, and offers to remove it', () => {
    const html = render({ ...account, avatarUpdatedAt: '2026-09-29T01:20:00.000Z' }, 'data:image/jpeg;base64,/9j/AA==');
    expect(html).toContain('src="data:image/jpeg;base64,/9j/AA=="');
    expect(html).toContain(`<span>${REMOVE_PHOTO}</span>`);
  });
});
