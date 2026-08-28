import { Node, SyntaxKind } from "ts-morph";
import { openProject } from "./project.ts";
import type { Transform } from "./types.ts";

/**
 * Move every import of one module to another, including subpaths
 * (`@acme/utils/date` -> `@acme/core/date`).
 *
 * This is the transform that makes the case for an AST over a regex. A
 * `sed s/@acme\/utils/@acme\/core/g` also rewrites the package name inside string
 * literals, comments, README snippets and unrelated identifiers. Here the edit is
 * only ever applied to the module-specifier node of an import, export or dynamic
 * import, because those are the only nodes asked for.
 */
export const rewriteImport: Transform = {
  name: "rewrite-import",
  describe: "Rewrite import/export module specifiers from one package to another (subpaths included)",
  requiredArgs: ["from", "to"],

  async apply(dir, args) {
    const { from, to } = args;
    const project = openProject(dir);
    let edits = 0;
    const files = new Set<string>();

    const next = (spec: string): string | null => {
      if (spec === from) return to!;
      if (spec.startsWith(`${from}/`)) return to + spec.slice(from!.length);
      return null;
    };

    for (const file of project.getSourceFiles()) {
      let touched = false;

      for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const lit = decl.getModuleSpecifier();
        if (!lit) continue;
        const replacement = next(lit.getLiteralValue());
        if (replacement === null) continue;
        lit.setLiteralValue(replacement);
        edits++;
        touched = true;
      }

      // Dynamic `import("...")`, which is a call expression, not an import declaration.
      file.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (node.getExpression().getKind() !== SyntaxKind.ImportKeyword) return;
        const [arg] = node.getArguments();
        if (!arg || !Node.isStringLiteral(arg)) return;
        const replacement = next(arg.getLiteralValue());
        if (replacement === null) return;
        arg.setLiteralValue(replacement);
        edits++;
        touched = true;
      });

      if (touched) files.add(file.getBaseName());
    }

    if (edits === 0) return { changed: false, summary: `no imports of ${from}` };
    await project.save();
    return { changed: true, summary: `${edits} import(s) of ${from} -> ${to} across ${files.size} file(s)` };
  },
};
