# hq

Connect your computer to your AI Team Cloud Computers in AI Workforce One HQ.

- `hq login` signs this computer in (you approve it in HQ in your browser). On a server or over a
  remote shell, `hq login --no-browser` prints the sign-in link instead of opening a browser.
- `hq status` lists your teams and their `hq-…` names.
- `hq attach <session>` follows an HQ session in this terminal. Only the session owner can type.
- `hq forward <port>` makes a port on the AI Team Cloud Computer reachable on `localhost` on this computer.
- `hq up <team>` wakes an AI Team Cloud Computer.
- `hq sessions` lists your sessions with their team, state and owner; `hq start`, `hq stop` and
  `hq restart <session>` start, stop or restart one (the session owner or a team owner only).
- `hq logout` revokes this computer's access.

Run `hq --help` for the full list. Guides and the full reference are at
[hq.aiworkforceone.com/docs/cli](https://hq.aiworkforceone.com/docs/cli/).

To work on a team's files in your editor, use the
[AI Workforce One HQ extension](https://hq.aiworkforceone.com/docs/vscode/) for VS Code, Cursor,
Windsurf or VSCodium.

## Install

```
npm install -g --ignore-scripts @aiworkforceoneofficial/hq
```

Node.js 20 or newer is required. The package has no dependencies and runs no install scripts.

## Notes

- An owner of your organization must turn on Developer access in HQ (Settings, Security).
  Attaching needs viewer access or more on a team; forwarding a port needs editor or owner access
  and an active plan.
- A forwarded port listens on `127.0.0.1` only. On the AI Team Cloud Computer, it reaches whatever listens on
  that port.
- Your HQ login is stored in the system keychain (macOS Keychain, or the Secret Service on Linux),
  or in `~/.hq/credentials.json` (readable only by you) where there is none. The keychain protects it
  with your user account, not per app: any program running as you can read it. `hq logout` revokes
  it on HQ.
