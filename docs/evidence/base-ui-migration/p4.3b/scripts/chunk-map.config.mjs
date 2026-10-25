// chunk-map.config.mjs: the web app's own vite config plus a plugin that writes, for every emitted chunk,
// its file, whether it is the entry, its static imports, its CSS and the src/ modules in it
// (CHUNK_MAP=<out.json>). Used to see which shared chunks carry the Orbit component styles.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const base = (await import(pathToFileURL(`${root}/vite.config.ts`).href)).default;
export default {
  ...base,
  plugins: [
    ...(base.plugins ?? []),
    {
      name: 'chunk-map',
      generateBundle(_options, bundle) {
        const chunks = [];
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue;
          chunks.push({
            file: item.fileName,
            isEntry: item.isEntry,
            isDynamicEntry: item.isDynamicEntry,
            imports: item.imports,
            dynamicImports: item.dynamicImports,
            css: [...(item.viteMetadata?.importedCss ?? [])],
            modules: Object.keys(item.modules).filter((id) => id.includes('/src/web/src/')).map((id) => id.replace(/^.*\/src\/web\/src\//, '')),
            cssModules: Object.keys(item.modules).filter((id) => /\.css($|\?)/.test(id)).map((id) => id.replace(/^.*\/src\/web\/src\//, '').replace(/^.*\/node_modules\//, 'node_modules/')),
          });
        }
        writeFileSync(process.env.CHUNK_MAP, JSON.stringify(chunks, null, 1));
      },
    },
  ],
};
