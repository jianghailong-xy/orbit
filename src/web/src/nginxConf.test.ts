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
    .split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/) // not at a `;` inside a quoted value
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

  it('names its link in the shell\'s head for a chat app, and only there', () => {
    // index.html's SSI include of /api/shared/<token>/card: WeChat read only "Orbit" off the bare shell.
    // Through `location /share-card/`, whose every refusal is empty: through /api/ a 404 wrote its JSON
    // into the head instead of the stub (nginx:alpine, 2026-11-13).
    expect(share).toContain('ssi on');
    expect(share).toContain('ssi_silent_errors on');
    expect(locationDirectives('/')).not.toContain('ssi on');
    const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(shell).toContain(
      '<!--# block name="bare_title" --><title>Orbit</title><!--# endblock -->' +
        '<!--# include virtual="/share-card/${share_token}/card" stub="bare_title" -->',
    );
    const card = locationDirectives('/share-card/');
    expect(card).toContain('internal');
    expect(card).toContain('proxy_pass http://apiserver:3000/api/shared/');
    expect(card).toContain('proxy_intercept_errors on');
    expect(card).toContain('error_page 400 403 404 429 500 502 503 504 = @no_share_card');
    expect(locationDirectives('@no_share_card')).toEqual(['return 204']);
    expect(conf).toMatch(/map \$request_uri \$share_token \{/);
  });
});

describe('nginx: hashed assets', () => {
  const assets = locationDirectives('/assets/');

  it('calls a file it has immutable, and says nothing of one it does not', () => {
    // `always` stamps the 404 too, and Chromium then keeps "no such chunk" for a year: past the
    // rollback or revert that brings that very file name back, and through every reload.
    expect(assets.filter((d) => d.startsWith('add_header '))).toEqual([
      'add_header Cache-Control "public, max-age=31536000, immutable"',
    ]);
  });

  it('answers a missing file with 404, never the SPA shell where the browser expects JavaScript', () => {
    expect(assets.filter((d) => d.startsWith('try_files '))).toEqual(['try_files $uri =404']);
  });
});

describe('nginx: the script a page waits for', () => {
  it('is kept for a day, so that no load waits on asking again, and says nothing of a file it does not have', () => {
    expect(locationDirectives('= /theme-boot.js')).toEqual(['add_header Cache-Control "public, max-age=86400"']);
  });
});

describe('nginx: runner downloads', () => {
  const dl = locationDirectives('/dl/');

  it('answers a missing file with 404, never the SPA shell a runner would read as a manifest', () => {
    // /dl/previous/version.json is absent until one release has replaced another (src/web/Dockerfile).
    expect(dl.filter((d) => d.startsWith('try_files '))).toEqual(['try_files $uri =404']);
  });

  it('is revalidated like the shell, so a cache never serves a release a deploy replaced', () => {
    expect(dl.filter((d) => d.startsWith('add_header '))).toEqual(['add_header Cache-Control "no-cache" always']);
  });
});

describe('nginx: the pages\' Content-Security-Policy', () => {
  const policyOf = (ds: string[]) => ds.filter((d) => d.startsWith('add_header Content-Security-Policy '));
  const pages = policyOf(locationDirectives('/'));

  /** One policy's directives, by name, read out of its `add_header` line. */
  const directivesOf = (line: string | undefined) =>
    new Map(
      (/^add_header Content-Security-Policy "(.*)" always$/.exec(line ?? '')?.[1] ?? '').split(';').map((d): [string, string[]] => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name, sources];
      }),
    );
  const loads = directivesOf(pages[0]);

  it('is on every answer of both blocks that serve the shell, and says the same in each', () => {
    expect(pages).toHaveLength(1);
    expect(policyOf(locationDirectives('/s/'))).toEqual(pages);
  });

  it('runs this origin\'s script files and nothing else: no inline code, no evaluated strings', () => {
    expect(loads.get('script-src')).toEqual(["'self'"]);
    expect(loads.get('default-src')).toEqual(["'self'"]);
    // A narrower directive would take over from script-src for what it names.
    expect([...loads.keys()].filter((name) => name.startsWith('script-src-'))).toEqual([]);
  });

  it('is one policy: a second one naming script paths stopped every script on iOS Safari 27.2', () => {
    expect(conf.replace(/#[^\n]*/g, '')).not.toContain('*:*/');
  });

  it('closes what default-src leaves open to a script or a form', () => {
    expect(loads.get('object-src')).toEqual(["'none'"]);
    expect(loads.get('base-uri')).toEqual(["'none'"]);
    expect(loads.get('form-action')).toEqual(["'self'"]);
  });

  it('leaves every other answer as it was: nothing at server level, nothing in another block', () => {
    // A server-level add_header would reach `location /api/`, which has none of its own, and put a
    // second policy on the files the apiserver answers with `Content-Security-Policy: sandbox`.
    const serverLevel = conf.replace(/#[^\n]*/g, '').replace(/location[^{]*\{[^}]*\}/g, '');
    expect(serverLevel).not.toContain('add_header');
    for (const block of ['/api/', '/assets/', '= /theme-boot.js', '/dl/', '= /healthz']) {
      expect(policyOf(locationDirectives(block))).toEqual([]);
    }
  });
});
