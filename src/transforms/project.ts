import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project } from "ts-morph";

/**
 * One ts-morph Project per repo checkout. Type information is not needed for these
 * transforms, so file dependency resolution and lib loading are skipped -- that is
 * the difference between ~100ms and several seconds per repo, which at fleet scale
 * is the difference between minutes and an hour.
 */
export function openProject(dir: string): Project {
  const tsconfig = join(dir, "tsconfig.json");
  const project = new Project({
    ...(existsSync(tsconfig) ? { tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true } : {}),
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });
  project.addSourceFilesAtPaths([
    `${dir}/**/*.{ts,tsx,mts,cts}`,
    `!${dir}/**/node_modules/**`,
    `!${dir}/**/dist/**`,
  ]);
  return project;
}
