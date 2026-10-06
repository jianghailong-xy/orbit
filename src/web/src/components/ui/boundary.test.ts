import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';
import { expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('../../..', import.meta.url));
const sourceRoot = resolve(webRoot, 'src');
const uiRoot = resolve(sourceRoot, 'components/ui');
const fixtureRoot = resolve(uiRoot, '__fixtures__');
const inside = (file: string, directory: string) => file === directory || file.startsWith(`${directory}${sep}`);

// Include type-only coupling; migration runners outside src may import the private fixture.
it('keeps Base UI inside Orbit components, fixtures private, and public components free of AntD', () => {
  const api = new API({ cwd: webRoot });
  const violations: { file: string; specifier: string; reason: string }[] = [];
  let importCount = 0;
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(webRoot, 'tsconfig.json')] });
    const project = snapshot.getProjects()[0];
    for (const file of project.rootFiles) {
      if (!inside(file, sourceRoot) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = project.program.getSourceFile(file)!;
      const visit = (node: ast.Node): void => {
        let target: ast.Node | undefined;
        if (ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) target = node.moduleSpecifier;
        else if (ast.isExternalModuleReference(node)) target = node.expression;
        else if (ast.isImportTypeNode(node) && ast.isLiteralTypeNode(node.argument)) target = node.argument.literal;
        else if (ast.isCallExpression(node)
          && (node.expression.kind === ast.SyntaxKind.ImportKeyword
            || (ast.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          target = node.arguments[0];
        }
        if (target && (ast.isStringLiteral(target) || ast.isNoSubstitutionTemplateLiteral(target))) {
          importCount++;
          const specifier = target.text;
          const report = (reason: string) => violations.push({ file, specifier, reason });
          if (/^@base-ui\/react(?:\/|$)/.test(specifier) && !inside(file, uiRoot)) report('Base UI outside ui');
          if (!inside(file, fixtureRoot) && (inside(resolve(dirname(file), specifier), fixtureRoot)
            || /(?:^|\/)ui\/__fixtures__(?:\/|$)/.test(specifier))) report('Private fixture in production');
          if (inside(file, uiRoot) && !inside(file, fixtureRoot) && /^antd(?:\/|$)/.test(specifier)) {
            report('AntD inside public ui');
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    snapshot.dispose();
  } finally {
    api.close();
  }
  expect(importCount).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
