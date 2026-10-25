import type { ReactNode } from 'react';

/** The app's root: div.orbit-app (root.css), the text and links the replaced App root gave everything under it.
 *  The unitless 22/14 line height is set here, inline, at full precision, as the replaced root had it from a
 *  runtime variable: in a stylesheet the build's minifier writes it as 1.57143, and every inherited line height
 *  then computes a hair over what it was (22.000019px for 22px in WebKit). */
export function AppRoot({ children }: { children: ReactNode }) {
  return <div className="orbit-app" style={{ lineHeight: 22 / 14 }}>{children}</div>;
}
