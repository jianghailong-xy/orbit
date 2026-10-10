// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Result } from './Result';

/**
 * The 404 the session console draws for a link that leads nowhere (P5.3): the replaced result's not-found picture in
 * the icon's place, the title and the sentence under it, and what to do about it below. The other statuses keep
 * their icon, and draw no actions row when they are given none.
 */

const parse = (markup: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host.firstElementChild as HTMLElement;
};

describe('Result', () => {
  it('draws the not-found picture, the words, and the way out for status 404', () => {
    const result = parse(renderToStaticMarkup(
      <Result status="404" title="Session not found" subTitle="This session doesn't exist or has been deleted."
        extra={<button type="button">Go home</button>} />,
    ));
    expect(result.dataset.status).toBe('404');
    const picture = result.querySelector('.orbit-result-image')!;
    expect(picture.classList.contains('orbit-result-icon')).toBe(true);
    expect(picture.getAttribute('aria-hidden')).toBe('true');
    const svg = picture.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['252', '294']);
    expect(picture.querySelector('.anticon')).toBeNull();
    expect(result.querySelector('.orbit-result-title')?.textContent).toBe('Session not found');
    expect(result.querySelector('.orbit-result-subtitle')?.textContent).toBe("This session doesn't exist or has been deleted.");
    expect(result.querySelector('.orbit-result-extra button')?.textContent).toBe('Go home');
    // In order: picture, title, sentence, actions.
    expect([...result.children].map((el) => el.className)).toEqual([
      'orbit-result-icon orbit-result-image', 'orbit-result-title', 'orbit-result-subtitle', 'orbit-result-extra',
    ]);
  });

  it('keeps the status icon, and no actions row, for the other statuses', () => {
    const result = parse(renderToStaticMarkup(<Result status="success" title="Registered" />));
    expect(result.querySelector('.orbit-result-icon .anticon-check-circle')).not.toBeNull();
    expect(result.querySelector('.orbit-result-image')).toBeNull();
    expect(result.querySelector('.orbit-result-extra')).toBeNull();
  });
});
