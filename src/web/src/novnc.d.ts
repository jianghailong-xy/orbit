// @novnc/novnc ships no types; lib/runnerBrowser.ts names the part of RFB the viewer uses (VncClientClass).
declare module '@novnc/novnc' {
  const RFB: unknown;
  export default RFB;
}
