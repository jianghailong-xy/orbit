// chunk-sizes.config.mjs: the web app's own vite config plus a plugin that writes, for every emitted chunk, its
// file, kind (entry / dynamic entry / shared), static imports, imported CSS, its CSS modules in order, and
// every module in it with its rendered length (CHUNK_MAP=<out.json>). For the bundle comparison by resource
// and by module (bundle-compare.py); the build output itself is the app's normal production build.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const base = (await import(pathToFileURL(`${root}/vite.config.ts`).href)).default;
const short = (id) => id.replace(/^.*\/src\/web\/src\//, 'src/').replace(/^.*\/node_modules\//, 'node_modules/').replace(/^.*\/src\/shared\//, 'shared/');
export default {
  ...base,
  plugins: [
    ...(base.plugins ?? []),
    {
      name: 'chunk-sizes',
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
            cssModules: Object.keys(item.modules).filter((id) => /\.css($|\?)/.test(id)).map(short),
            modules: Object.entries(item.modules).map(([id, m]) => [short(id), m.renderedLength]),
          });
        }
        writeFileSync(process.env.CHUNK_MAP, JSON.stringify(chunks));
      },
    },
  ],
};
