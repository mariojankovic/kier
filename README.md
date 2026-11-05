# Kier

Kier is a personal assistant for macOS. It reads your activity, finds things you owe people, and looks for evidence that they are done. The app, vault and built-in models run on your Mac. There is no Kier account or hosted vault.

With the macOS permissions you grant, [collectors](daemon/collectors/) read supported chat and call databases, contacts, calendar events, browser history, downloads, Git work and AI sessions. [The app](app/main.swift) reads clipboard changes, app activity and visible chat messages through Accessibility. [Setup settings](daemon/lib/settings.mjs) let you disable sources. [Redaction](daemon/lib/redact.mjs) masks recognized credentials and financial identifiers; [privacy filters](daemon/lib/privacy.mjs) exclude adult content and let you forget items.

Kier does not send chat replies or make payments. External model servers are optional and receive inference context when selected in [model settings](daemon/lib/model-settings.mjs). Optional [online helpers](daemon/lib/config.mjs), [cloud reviews](daemon/lib/doublecheck.mjs), and explicit [Claude or Codex handoffs](daemon/lib/handoff.mjs) can send relevant context outside your Mac. [Phone sync](app/PhoneSync.swift) is off by default; enabling it writes to Calendar and Reminders, whose account provider may sync those items to your other devices. [MCP](daemon/bin/mcp.mjs) lets local AI clients query the vault and records access.

To build, use an Apple Silicon Mac with macOS 14 or later, Xcode command line tools with the Metal compiler, Node 23 or later, and Python 3. Run:

```sh
npm --prefix daemon ci
npm --prefix daemon test
scripts/build-app.sh
```

The development app is written to `~/Applications/Kier.app` and runs the daemon from this checkout. Set `KIER_APP` to build elsewhere. The build fetches and verifies Sparkle. Signing uses an available development certificate or an ad hoc signature. Grant macOS permissions and install the local model through Setup. `scripts/package-app.sh` makes a self-contained download; packaging also needs Bun and a Developer ID certificate. Release signing, notary profiles, update feed and repository settings can be supplied through environment variables or a private `scripts/local.env` file. Never commit that file.

This repo is a read only copy of each release. Kier does not take pull requests; open an issue.

The code is available under [FSL-1.1-ALv2](LICENSE), with Apache 2.0 as its future license. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Codex Ask is currently unavailable: its CLI does not provide a verified Kier-only tools boundary. Requests fail before vault access or agent launch. Explicit interactive handoffs remain separate. MCP defaults to a server-enforced read-only role; an owner-configured client must explicitly set `KIER_MCP_ROLE=read-write` to enable marking tasks. Source scopes and disabled sources apply to nested evidence as well as the initial result.

## No warranty

Kier is free and provided as is, without warranty of any kind. Using it means you accept the [terms of use](https://getkier.com/terms/): Kier reads what you switch on, keeps it on your Mac, and the author is not liable for data loss, exposure or any other damage, to the fullest extent the law allows. Keeping your Mac secure (login, FileVault, updates, backups) is up to you. See [LICENSE](LICENSE) for the license terms.
