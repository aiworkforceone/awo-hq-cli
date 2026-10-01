/**
 * Renders /docs/cli/reference (feature hq-docs, Decisions 6 and 7) from the command manifest. The
 * output is COMMITTED at `REFERENCE_MDX_PATH` (`npm run gen:cli-docs` writes it) so the docs build
 * never reads cli/, and `command-manifest.test.ts` plus `hq-cli-ci.yml` fail when it is stale.
 *
 * Not part of the `hq` bundle: nothing main.ts imports reaches this file.
 */
import {
  CLI_COMMANDS,
  CLI_ENV,
  GLOBAL_FLAGS,
  type CliCommand,
  type CliFlag,
} from './command-manifest.js';

/** Relative to the repo root. */
export const REFERENCE_MDX_PATH = 'docs-site/content/docs/cli/reference.mdx';

/**
 * Prose from the manifest into MDX: code spans (`…`) pass through, and outside them `<`, `>`, `{`
 * and `}` are escaped, so a placeholder like <team> never parses as a JSX tag or an expression.
 */
function prose(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? part
        : part
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}'),
    )
    .join('');
}

/** A GFM table cell: a `|` ends the cell even inside a code span unless it is escaped. */
function cell(text: string): string {
  return prose(text).replace(/\|/g, '\\|');
}

function flagCell(f: CliFlag): string {
  return cell(
    `\`--${f.name}${f.valueHint ? (f.valueHint.startsWith('[') ? '' : ' ') + f.valueHint : ''}\``,
  );
}

function flagTable(flags: CliFlag[]): string[] {
  return [
    '| Flag | Description |',
    '| --- | --- |',
    ...flags.map((f) => `| ${flagCell(f)} | ${cell(f.description)} |`),
  ];
}

function commandSection(c: CliCommand): string[] {
  const out = [`## hq ${c.name}`, '', prose(c.summary), ''];
  if (c.removed) {
    out.push(
      '<Callout title="Removed">',
      '  This command only prints that SSH was removed and exits. It no longer connects.',
      '</Callout>',
      '',
    );
  }
  out.push('```bash', ...c.usage, '```', '');
  if (c.flags.length > 0) out.push('**Flags**', '', ...flagTable(c.flags), '');
  out.push('**Examples**', '', '```bash');
  c.examples.forEach((e, i) => {
    if (i > 0) out.push('');
    out.push(`# ${e.description.replace(/`/g, '')}`, e.cmd);
  });
  out.push('```', '');
  out.push(
    '**Exit codes**',
    '',
    '| Code | Meaning |',
    '| --- | --- |',
    ...c.exitCodes.map((e) => `| \`${e.code}\` | ${cell(e.meaning)} |`),
    '',
  );
  return out;
}

/** The whole page. Deterministic: the same manifest always renders the same bytes. */
export function renderReferenceMdx(): string {
  const people = CLI_COMMANDS.filter((c) => !c.removed);
  const removed = CLI_COMMANDS.filter((c) => c.removed);
  return [
    '---',
    'title: CLI reference',
    'description: Every hq command, its flags, an example and its exit codes.',
    '---',
    '',
    '{/* Generated from cli/src/command-manifest.ts by `npm run gen:cli-docs`. Do not edit by hand. */}',
    '',
    'This page is generated from the same command list `hq --help` prints, so the two always agree.',
    'Wherever a command takes `<team>`, use the `hq-…` name from `hq status` or the team name.',
    '',
    '## Global flags',
    '',
    ...flagTable(GLOBAL_FLAGS),
    '',
    '## Exit code 2',
    '',
    'Every command exits `2` when it is missing a required argument (`hq` prints',
    '`hq: missing arguments for "…". Run hq --help.`), and `hq` exits `2` for an unknown command or',
    "when run with no command at all. The tables below list each command's other codes.",
    '',
    '## Environment variables',
    '',
    '| Variable | Description |',
    '| --- | --- |',
    ...CLI_ENV.map((v) => `| \`${v.name}\` | ${cell(v.description)} |`),
    '',
    ...people.flatMap(commandSection),
    ...removed.flatMap(commandSection),
  ]
    .join('\n')
    .replace(/\n+$/, '\n');
}
