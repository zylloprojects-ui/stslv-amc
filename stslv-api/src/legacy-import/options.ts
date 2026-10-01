export interface DryRunOptions {
  config: string | null;
  out: string | null;
}

/**
 * The two options the dry-run script has, each followed by its value.
 * Anything else stops the run: in particular there is no option, under any
 * name, that imports data.
 */
export function parseArguments(argv: string[]): DryRunOptions {
  const options: DryRunOptions = { config: null, out: null };

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if ((name !== "--config" && name !== "--out") || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${name}. This script only performs a dry run; it has no option that imports data.`);
    }

    options[name === "--config" ? "config" : "out"] = value;
  }

  return options;
}
