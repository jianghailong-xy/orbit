/**
 * How the console hands over bytes somebody else wrote: an upload, a file from a runner. A document opened
 * from a blob: URL runs on Orbit's own origin, beside the login, and no response header reaches it, so
 * the rule the server keeps with its headers (apiserver files/user-file-response.ts) is kept here too:
 * every URL for such bytes comes from this file, and none of them can be opened into a page that runs.
 */

/** The types a browser shows without running anything the file carries: the server's list. */
const OPENS_IN_BROWSER = new Set([
  'application/pdf',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

const SVG = 'image/svg+xml';

const mediaType = (type: string): string => type.split(';', 1)[0].trim().toLowerCase();

/**
 * An object URL for `blob`, which opens as what it is only when its type is on the list. Anything else is
 * labelled as bytes: a browser saves those rather than read them as a page, and an `<img>` still decodes a
 * picture from them.
 */
export function inertObjectUrl(blob: Blob): string {
  const type = mediaType(blob.type);
  return URL.createObjectURL(new Blob([blob], { type: OPENS_IN_BROWSER.has(type) ? type : 'application/octet-stream' }));
}

/**
 * A URL for a file's bytes, for an `<img>` to draw or `saveUserFile` to save. An `<img>` draws SVG only
 * when it is labelled as SVG, which an object URL must not be, so SVG comes as a data: URL: that belongs
 * to no origin, should it be opened on its own.
 */
export function userFileUrl(blob: Blob): Promise<string> {
  if (mediaType(blob.type) !== SVG) return Promise.resolve(inertObjectUrl(blob));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function press(a: HTMLAnchorElement): void {
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Hand a URL from this file to the browser as a download under the file's own name. */
export function saveUserFile(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  press(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Open a file the server answers without a login, from the press that asked for it: in a new tab when
 * its type may be shown, as a download when it may not. The address itself, never its bytes fetched first,
 * because the page that opens is then the server's answer with the server's headers, and because Safari
 * gives a new tab to the press alone and refuses one that comes after a fetch.
 */
export function openUserFile(url: string, type: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (OPENS_IN_BROWSER.has(mediaType(type))) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  } else {
    a.download = name;
  }
  press(a);
}
