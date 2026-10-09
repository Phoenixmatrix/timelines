// The gm command reference (CORE-115), from a snapshot of `gm cli commands`
// (src/data/gm-commands.json; `vp run site#gm-reference` refreshes it). The
// reference test checks the snapshot against apps/cli/src/meta.rs.

export interface GmParam {
  name: string;
  short?: string;
  required: boolean;
  multiple: boolean;
  flag: boolean;
  default?: string;
  choices?: string[];
  description: string;
}
export interface GmCommand {
  command: string;
  summary: string;
  usage: string;
  aliases?: string[];
  git?: string;
  mutates: boolean;
  arguments: GmParam[];
  options: GmParam[];
  examples: string[];
}
export interface GmManifest {
  commands: GmCommand[];
  global_options: GmParam[];
}
export interface GmGroup {
  name: string;
  commands: GmCommand[];
}

/** The anchor a command has in the reference: `gm timeline start` is `gm-timeline-start`. */
export function commandSlug(command: string): string {
  return command.trim().split(/\s+/).join("-");
}

/** Commands grouped by their first word after `gm`, in the manifest's order. */
export function groupCommands(commands: readonly GmCommand[]): GmGroup[] {
  const groups = new Map<string, GmCommand[]>();
  for (const command of commands) {
    const name = command.command.split(/\s+/)[1] ?? command.command;
    groups.set(name, [...(groups.get(name) ?? []), command]);
  }
  return [...groups].map(([name, grouped]) => ({ name, commands: grouped }));
}

/** How a parameter reads in the reference: `--policy <auto|approval>`, `-m, --message <message>`. */
export function paramLabel(param: GmParam): string {
  const name = param.short ? `${param.short}, ${param.name}` : param.name;
  if (param.flag || !param.name.startsWith("-")) return name;
  const value = param.choices?.length ? param.choices.join("|") : param.name.replace(/^-+/, "");
  return `${name} <${value}>${param.multiple ? "…" : ""}`;
}
