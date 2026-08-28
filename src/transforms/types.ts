export type TransformArgs = Record<string, string>;
export type TransformResult = { changed: boolean; summary: string };

export type Transform = {
  name: string;
  describe: string;
  requiredArgs: string[];
  /** Mutate the checkout in `dir` in place. Must be idempotent: a second run changes nothing. */
  apply(dir: string, args: TransformArgs): Promise<TransformResult>;
};
