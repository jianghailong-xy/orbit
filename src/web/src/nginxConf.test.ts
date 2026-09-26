import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What the web image's nginx says about a public share page (`/s/…`), read out of the file the
 * image copies in (src/web/Dockerfile: `COPY src/web/nginx.conf /etc/nginx/conf.d/default.conf`).
 *
 * The page's address is the capability that opens it: a search engine must not keep it
 * (X-Robots-Tag) and a site its reader clicks through to must not be handed it (Referrer-Policy).
 * Two nginx rules decide whether those headers actually reach the browser, and both are held here:
 * an `add_header` in a block drops the ones it would inherit, and headers belong to the block that
 * finally serves the response — which, after `try_files … /index.html`, is `location /`, not this
 * one (`nginx:alpine`, 2026-09-25: that spelling served /s/<token> with neither header).
 */

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

/** The directives of `location <prefix> { … }`, comments dropped and whitespace collapsed. */
function locationDirectives(prefix: string): string[] {
  const code = conf.replace(/#[^\n]*/g, '');
  const open = code.indexOf(`location ${prefix} {`);
  if (open < 0) throw new Error(`nginx.conf has no \`location ${prefix}\` block`);
  const start = code.indexOf('{', open) + 1;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < code.length) {
    if (code[end] === '{') depth += 1;
    if (code[end] === '}') depth -= 1;
    end += 1;
  }
  return code
    .slice(start, end - 1)
    .split(';')
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('nginx: a public share page', () => {
  const share = locationDirectives('/s/');

  it('is not to be indexed, and is not handed on in a Referer', () => {
    expect(share).toContain('add_header X-Robots-Tag "noindex, nofollow" always');
    expect(share).toContain('add_header Referrer-Policy "no-referrer" always');
  });

  it('still says what the SPA shell says about caching', () => {
    const cacheControl = (ds: string[]) => ds.filter((d) => d.startsWith('add_header Cache-Control '));
    expect(cacheControl(share)).toEqual(cacheControl(locationDirectives('/')));
    expect(cacheControl(share)).toEqual(['add_header Cache-Control "no-cache" always']);
  });

  it('is served the SPA shell from its own block, so its headers are the ones sent', () => {
    // A last argument that is a URI would redirect internally, into `location /` and its headers.
    expect(share.filter((d) => d.startsWith('try_files '))).toEqual(['try_files /index.html =404']);
    // Every other path still falls back to the shell.
    expect(locationDirectives('/')).toContain('try_files $uri $uri/ /index.html');
  });
});
