# hq

Connect your computer to your AI Workforce One HQ team machines.

- `hq login` signs this computer in (you approve it in HQ in your browser).
- `hq ssh --config` writes your teams to `~/.ssh/hq_config` (Included from `~/.ssh/config`), so
  `ssh hq-<id>` and Remote-SSH-compatible editors such as Cursor, JetBrains Gateway and Zed can open
  a team machine. sshfs works too.
- `hq attach <session>` follows an HQ session in this terminal. Only the session owner can type.
- `hq forward <port>` makes a port on the team machine reachable on this computer.
- `hq up <team>` wakes a team machine. `hq open cursor <team>` wakes it and opens your editor.
- `hq status` lists your teams. `hq logout` revokes this computer's access.

## Install

```
npm install -g --ignore-scripts @aiworkforceoneofficial/hq
```

Node.js 20 or newer is required. The package has no dependencies and runs no install scripts.

## Notes

- Your organization owner must turn on Remote access, and you need Advanced terminal rights on a
  team, before `ssh` works there.
- A plain SSH shell gets the team's stored secrets and variables, and its output is not masked.
- Jobs started in a plain SSH shell stop when the connection closes (hourly at the latest). Use an
  HQ session or a schedule for long runs.
- Type `claude` in an SSH shell to start or join an HQ session, so the conversation stays in HQ.
- Your HQ login is stored in the system keychain (macOS Keychain, or the Secret Service on Linux),
  or in `~/.hq/credentials.json` (readable only by you) where there is none. The keychain protects it
  with your user account, not per app: any program running as you can read it. `hq logout` revokes
  it on HQ.
