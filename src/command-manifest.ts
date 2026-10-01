/**
 * The `hq` command manifest (feature hq-docs, Decision 6): the ONE place a command, a flag, an
 * example or an exit code is described. Two things render from it and nothing else describes them:
 *
 *   - `hq --help` (`renderUsage`, which main.ts exports as `USAGE`);
 *   - the generated /docs/cli/reference page (`command-reference.ts` → `npm run gen:cli-docs`).
 *
 * Adding a command or a flag to main.ts without adding it here fails `command-manifest.test.ts`,
 * which reads main.ts's `case` labels and `flagString`/`args.flags` reads. The text is what a person
 * reads in a terminal and on a public page, so it follows the docs copy rules: no em dashes, and a
 * team machine that idles is "sleeping", never the other word.
 */
import { SSH_REMOVED_MESSAGE } from '@kpa/shared/remote.types';

export interface CliFlag {
  /** Without the leading `--`. */
  name: string;
  /** `<url>`, `<t>`, `[=auto|always|off]`; absent for a switch. */
  valueHint?: string;
  description: string;
  /** A global flag that also works as a bare command (`hq help`, `hq version`). */
  alsoCommand?: boolean;
}

/** One line of `hq --help`. */
export interface HelpLine {
  text: string;
  /** Printed from the description column; a line without one is printed as is. */
  summary?: string;
}

export interface CliCommand {
  name: string;
  /** Synopsis lines for the reference page. */
  usage: string[];
  /** One or two sentences for the reference page. */
  summary: string;
  /** The `hq --help` lines; empty for a removed command. */
  help: HelpLine[];
  flags: CliFlag[];
  examples: { cmd: string; description: string }[];
  exitCodes: { code: number; meaning: string }[];
  /**
   * Removed (SSH, 2026-10-01): kept only as a stub that prints why and what to use instead. Never in
   * `hq --help`; listed last on the reference page so a person searching for it finds the reason.
   */
  removed?: boolean;
}

export const CLI_TAGLINE = 'connect this computer to your HQ team machines';

const HELP_FOOTNOTE =
  "<team> is the hq-… name from hq status, or the team's name. --org <slug> narrows either.";

const ORG_FLAG: CliFlag = {
  name: 'org',
  valueHint: '<slug>',
  description: 'Only look in this organization, when you belong to more than one.',
};

/** Flags every command accepts (read before the command runs). */
export const GLOBAL_FLAGS: CliFlag[] = [
  {
    name: 'help',
    alsoCommand: true,
    description: 'Print the command list and exit. `-h` and `hq help` work too.',
  },
  {
    name: 'version',
    alsoCommand: true,
    description: 'Print the CLI version and exit. `hq version` works too.',
  },
];

/** Environment variables the CLI reads (paths.ts, state.ts, keychain.ts, local-echo/mode.ts). */
export const CLI_ENV: { name: string; description: string }[] = [
  {
    name: 'HQ_HOST',
    description:
      'The HQ address every command uses, overriding the one saved at `hq login`. Must be https.',
  },
  {
    name: 'HQ_HOME',
    description: 'Where the CLI keeps its state, device key and fallback login. Default `~/.hq`.',
  },
  {
    name: 'HQ_LOCAL_ECHO',
    description: '`auto`, `always` or `off` for `hq attach`. The `--local-echo` flag wins over it.',
  },
  {
    name: 'HQ_KEYCHAIN',
    description:
      'Set to `file` to store the login in `~/.hq/credentials.json` (readable only by you) instead of the system keychain.',
  },
];

export const CLI_COMMANDS: CliCommand[] = [
  {
    name: 'login',
    usage: ['hq login [--host <url>]'],
    summary:
      'Sign this computer in with a one-time code you approve in HQ in your browser. The login is stored in the system keychain, or in `~/.hq/credentials.json` where there is none.',
    help: [
      {
        text: 'hq login [--host <url>]',
        summary: 'sign this computer in (approve it in your browser)',
      },
    ],
    flags: [
      {
        name: 'host',
        valueHint: '<url>',
        description:
          'The HQ address to sign in to. Defaults to `https://hq.aiworkforceone.com`, or to `HQ_HOST` when set. Only localhost may use plain `http`.',
      },
    ],
    examples: [
      { cmd: 'hq login', description: 'Sign in to HQ. Your browser opens the approval page.' },
      {
        cmd: 'hq login --host https://hq.aiworkforceone.com',
        description: 'Sign in to a specific HQ address.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Signed in.' },
      {
        code: 1,
        meaning:
          'The login was denied in the browser, the code expired, or HQ could not be reached.',
      },
    ],
  },
  {
    name: 'status',
    usage: ['hq status'],
    summary:
      'Show who is signed in and every team you can reach, with its `hq-…` name, whether its machine is running, and what you may do there.',
    help: [{ text: 'hq status', summary: 'who you are and the teams you can reach' }],
    flags: [],
    examples: [{ cmd: 'hq status', description: 'List your teams and their `hq-…` names.' }],
    exitCodes: [
      { code: 0, meaning: 'Printed.' },
      { code: 1, meaning: 'Not signed in, or HQ could not be reached.' },
    ],
  },
  {
    name: 'up',
    usage: ['hq up <team> [--org <slug>]'],
    summary:
      'Wake a sleeping team machine and wait until it is ready (about 15 seconds, up to 3 minutes).',
    help: [{ text: 'hq up <team>', summary: 'wake a team machine' }],
    flags: [ORG_FLAG],
    examples: [{ cmd: 'hq up hq-3f9a1c2e', description: 'Wake the team with this `hq-…` name.' }],
    exitCodes: [
      { code: 0, meaning: 'The team machine is running.' },
      {
        code: 1,
        meaning:
          'No such team, remote access is off, or the machine did not wake within 3 minutes.',
      },
      { code: 2, meaning: 'No team named.' },
    ],
  },
  {
    name: 'attach',
    usage: ['hq attach <session> [--team <t>] [--local-echo[=auto|always|off]] [--org <slug>]'],
    summary:
      'Join an HQ session in this terminal and follow it live. Only the session owner can type; everyone else watches. Press `Ctrl-]` to detach; the session keeps running.',
    help: [
      {
        text: 'hq attach <session> [--team <t>]',
        summary: 'join an HQ session in this terminal (Ctrl-] to detach)',
      },
      {
        text: '    [--local-echo[=auto|always|off]]',
        summary: 'show what you type instantly (or set HQ_LOCAL_ECHO)',
      },
    ],
    flags: [
      {
        name: 'team',
        valueHint: '<t>',
        description:
          'Only look for the session in this team (its `hq-…` name or its name). Use it when the same session name exists in two teams.',
      },
      {
        name: 'local-echo',
        valueHint: '[=auto|always|off]',
        description:
          'Draw what you type immediately instead of after the round trip. Bare `--local-echo` means `auto`. Wins over `HQ_LOCAL_ECHO`; off when neither is set. Your organization must allow it.',
      },
      ORG_FLAG,
    ],
    examples: [
      {
        cmd: 'hq attach 7c21e0b4',
        description: 'Attach by the first characters of the session id.',
      },
      {
        cmd: 'hq attach "fix login bug" --team hq-3f9a1c2e --local-echo',
        description: 'Attach by session name in one team, with local echo.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Detached with `Ctrl-]`, or the session ended.' },
      {
        code: 1,
        meaning:
          'No session matched (or more than one did), HQ could not be reached, or your access ended.',
      },
      { code: 2, meaning: 'No session named, or `--local-echo` was not auto, always or off.' },
    ],
  },
  {
    name: 'forward',
    usage: ['hq forward <port> [--local <port>] [--team <t>] [--org <slug>]'],
    summary:
      'Make a port on the team machine reachable at `http://localhost:<port>` on this computer, until you press `Ctrl-C`.',
    help: [{ text: 'hq forward <port> [--local <port>] [--team <t>]' }],
    flags: [
      {
        name: 'local',
        valueHint: '<port>',
        description:
          'The port on this computer. Defaults to the same number as the team port. It listens on 127.0.0.1 only.',
      },
      {
        name: 'team',
        valueHint: '<t>',
        description:
          'Which team to forward from. Optional when exactly one of your teams lets you forward ports.',
      },
      ORG_FLAG,
    ],
    examples: [
      {
        cmd: 'hq forward 3000',
        description: 'Reach port 3000 on the team machine at localhost:3000.',
      },
      {
        cmd: 'hq forward 5173 --local 8080 --team hq-3f9a1c2e',
        description: 'Reach port 5173 of one team at localhost:8080.',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Stopped with `Ctrl-C`.' },
      {
        code: 1,
        meaning:
          'No team lets you forward, the local port is taken, or the forward ended on the HQ side.',
      },
      {
        code: 2,
        meaning:
          'The team port is missing or not a number from 1024 to 65535, or `--local` is not a port.',
      },
    ],
  },
  {
    name: 'logout',
    usage: ['hq logout'],
    summary:
      "Revoke this computer's access on HQ (in every organization) and remove the stored login.",
    help: [{ text: 'hq logout', summary: "sign out and revoke this computer's access" }],
    flags: [],
    examples: [{ cmd: 'hq logout', description: 'Sign out and revoke this computer.' }],
    exitCodes: [
      {
        code: 0,
        meaning:
          'Signed out. If HQ could not be reached, the login is still removed from this computer and a warning is printed.',
      },
    ],
  },
  {
    name: 'ssh',
    removed: true,
    usage: ['hq ssh'],
    summary: SSH_REMOVED_MESSAGE,
    help: [],
    flags: [],
    examples: [{ cmd: 'hq ssh', description: 'Prints that SSH was removed and what to use.' }],
    exitCodes: [{ code: 1, meaning: 'Always: SSH was removed.' }],
  },
  {
    name: 'ssh-proxy',
    removed: true,
    usage: ['hq ssh-proxy'],
    summary: `${SSH_REMOVED_MESSAGE} An old \`Host hq-…\` entry in \`~/.ssh/hq_config\` still runs this; delete that file and its \`Include\` line in \`~/.ssh/config\`.`,
    help: [],
    flags: [],
    examples: [
      { cmd: 'hq ssh-proxy', description: 'Prints that SSH was removed and what to use.' },
    ],
    exitCodes: [
      {
        code: 255,
        meaning: 'Always: SSH was removed (what ssh itself uses, so an editor reports it).',
      },
    ],
  },
  {
    name: 'open',
    removed: true,
    usage: ['hq open'],
    summary: SSH_REMOVED_MESSAGE,
    help: [],
    flags: [],
    examples: [{ cmd: 'hq open', description: 'Prints that SSH was removed and what to use.' }],
    exitCodes: [{ code: 1, meaning: 'Always: SSH was removed.' }],
  },
];

/** The description column of `hq --help` (two spaces of indent, then 35 for the command). */
const HELP_COLUMN = 37;

function helpLine(line: HelpLine): string {
  const lead = `  ${line.text}`;
  if (line.summary === undefined) return lead;
  return lead.length < HELP_COLUMN
    ? `${lead.padEnd(HELP_COLUMN)}${line.summary}`
    : `${lead} ${line.summary}`;
}

/** `hq --help`. */
export function renderUsage(version: string): string {
  return [
    `hq ${version}: ${CLI_TAGLINE}`,
    '',
    'Usage:',
    ...CLI_COMMANDS.flatMap((c) => c.help.map(helpLine)),
    '',
    HELP_FOOTNOTE,
  ].join('\n');
}
