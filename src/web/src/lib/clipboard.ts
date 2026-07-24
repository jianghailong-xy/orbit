// Copy text to the clipboard, resolving to whether it actually succeeded.
//
// The async Clipboard API (`navigator.clipboard`) only exists in secure contexts —
// HTTPS or localhost. When Orbit is opened over plain HTTP or a bare IP it's
// `undefined`, so `navigator.clipboard?.writeText(...)` silently short-circuits to
// `undefined` and nothing is copied. Callers must gate their "Copied ✓" affordance on
// this result — a failed copy that still shows success is worse than an honest failure.
//
// When the Clipboard API is missing or rejects, we fall back to the legacy
// execCommand path (a hidden textarea + document.execCommand('copy')), which still
// works in insecure contexts, so copy keeps working rather than merely failing quietly.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, document not focused, blocked by policy — fall through to legacy.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen and inert so selecting it doesn't scroll the page or steal focus visibly.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
