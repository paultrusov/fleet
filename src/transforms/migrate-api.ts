import { Node } from "ts-morph";
import { openProject } from "./project.ts";
import type { Transform } from "./types.ts";

/**
 * Migrate a function from positional arguments to a single options object, and
 * rename it: `fetchData(url, opts)` -> `fetchDataV2({ url: url, options: opts })`.
 *
 * Only call expressions whose callee is an identifier with that exact name and
 * whose arity matches are rewritten, and the named import is renamed alongside
 * them. A call already passing an object literal is left alone, which is what
 * makes a second run a no-op.
 */
export const migrateApi: Transform = {
  name: "migrate-api",
  describe: "Migrate positional call arguments to an options object and rename the function",
  requiredArgs: ["fn", "to", "params"],

  async apply(dir, args) {
    const fn = args.fn!;
    const to = args.to!;
    const params = args.params!.split(",").map((p) => p.trim()).filter(Boolean);
    const project = openProject(dir);
    let calls = 0;
    let imports = 0;

    for (const file of project.getSourceFiles()) {
      let touched = false;

      file.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const callee = node.getExpression();
        if (!Node.isIdentifier(callee) || callee.getText() !== fn) return;
        const callArgs = node.getArguments();
        if (callArgs.length === 0 || callArgs.length > params.length) return;
        if (callArgs.length === 1 && Node.isObjectLiteralExpression(callArgs[0]!)) return; // already migrated
        const fields = callArgs.map((a, i) => `${params[i]}: ${a.getText()}`).join(", ");
        node.replaceWithText(`${to}({ ${fields} })`);
        calls++;
        touched = true;
      });

      for (const decl of file.getImportDeclarations()) {
        for (const spec of decl.getNamedImports()) {
          if (spec.getName() !== fn) continue;
          spec.setName(to);
          imports++;
          touched = true;
        }
      }

      void touched; // no formatText(): a codemod PR should not reindent files it did not change
    }

    if (calls === 0 && imports === 0) return { changed: false, summary: `no calls to ${fn}` };
    await project.save();
    return { changed: true, summary: `${calls} call(s) and ${imports} import(s): ${fn} -> ${to}` };
  },
};
