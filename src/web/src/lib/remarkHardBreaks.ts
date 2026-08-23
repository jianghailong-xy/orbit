/**
 * A remark plugin turning every single newline into a hard break — what remark-breaks does, inlined
 * rather than pulling in a dependency for it.
 *
 * For text a person laid out by hand rather than wrote as reflowable prose: a message typed in a
 * composer where Enter means "new line" (`MD breaks`), and a project's goal, acceptance criteria
 * and instructions, which were rendered pre-wrapped before they were read as Markdown. CommonMark's
 * soft break collapses to a space, which would silently run those lines together. Assistant
 * Markdown keeps the standard semantics. `code`/`inlineCode`/`html` nodes hold no children and no
 * 'text' node, so their contents are never touched.
 */
export function remarkHardBreaks() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && child.value.includes('\n')) {
          child.value.split(/\r?\n/).forEach((part: string, i: number) => {
            if (i) out.push({ type: 'break' });
            if (part) out.push({ type: 'text', value: part });
          });
        } else {
          walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}
