# pi-opencode-zen

[Pi](https://pi.dev) provider extension for [OpenCode Zen](https://opencode.ai/docs/zen) — device-flow OAuth login with your OpenCode workspace account, no API key management needed.

Works for workspace **members**: `/login opencode-zen` opens the OpenCode device-code page, you approve in the browser, and pi stores/refreshes the OAuth token itself. If your account belongs to multiple workspaces, pi asks you to pick one; requests carry the matching `x-opencode-org-id` header.

## Install

Copy into your pi extensions directory:

```sh
git clone https://github.com/Naab2k3/pi-opencode-zen ~/.pi/agent/extensions/opencode-zen
```

Or copy `index.ts` and `package.json` into `~/.pi/agent/extensions/opencode-zen/` manually, then restart pi (or `/reload`).

## Usage

```
/login opencode-zen        # device-flow OAuth via opencode.ai console
/model opencode-zen/glm-5.3-flash
```

Fallback: set `OPENCODE_API_KEY` to use a Zen API key instead of OAuth.

## Models

Ships with the Zen free-tier models that work outside the opencode client:

| id | notes |
|----|-------|
| `glm-5.3-flash` | text |
| `deepseek-v4.1-flash` | text, image |

Add models by appending to `MODELS` in `index.ts`.

## Notes

- The extension sends an opencode `User-Agent` (resolved from the npm registry) because the Zen edge rejects non-opencode clients on the free tier. Paid workspaces should work the same way once billing is enabled.
- Credentials live in `~/.pi/agent/auth.json` (managed by pi), never in this repo.

## License

MIT
