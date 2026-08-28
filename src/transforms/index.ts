import { bumpDep } from "./bump-dep.ts";
import { migrateApi } from "./migrate-api.ts";
import { rewriteImport } from "./rewrite-import.ts";
import type { Transform } from "./types.ts";

export const TRANSFORMS: Record<string, Transform> = {
  [bumpDep.name]: bumpDep,
  [rewriteImport.name]: rewriteImport,
  [migrateApi.name]: migrateApi,
};

export function getTransform(name: string): Transform {
  const t = TRANSFORMS[name];
  if (!t) {
    throw new Error(`Unknown transform "${name}". Available: ${Object.keys(TRANSFORMS).join(", ")}`);
  }
  return t;
}
