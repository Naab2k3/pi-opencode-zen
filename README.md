# pi-opencode-zen

[Pi](https://pi.dev) provider extension for [OpenCode Zen](https://opencode.ai/docs/zen) — device-flow OAuth login with your OpenCode workspace account, no API key management needed.

Works for workspace **members**: `/login opencode-zen` opens the OpenCode device-code page, you approve in the browser, and pi stores/refreshes the OAuth token itself. If your account belongs to multiple workspaces, pi asks you to pick one; requests carry the matching `x-opencode-org-id` header.

## Install

```sh
pi install git:github.com/Naab2k3/pi-opencode-zen@v1.0.0
```

Or clone into your pi extensions directory manually and restart pi (or `/reload`).

## Usage

```
/login opencode-zen        # device-flow OAuth via opencode.ai console
/model opencode-zen/glm-5.3-flash
```

Fallback: set `OPENCODE_API_KEY` to use a Zen API key instead of OAuth.

## Models

Ships with two Zen paid models (billed to the selected workspace, prices per million tokens from the console config):

| id | input | output | cache read | inputs |
|----|-------|--------|------------|--------|
| `glm-5.3-flash` | $0.15 | $0.50 | $0.03 | text |
| `deepseek-v4.1-flash` | $0.30 | $1.20 | $0.006 | text, image |

Note: the Zen edge serves the inference API only to opencode clients, so the extension sends an opencode `User-Agent` (resolved from the npm registry). Add models by appending to `MODELS` in `models.ts`.

## Layout

- `index.ts` — entry point pi loads; re-exports `src/extension.ts`
- `src/extension.ts` — provider assembly (`createProvider`) and registration
- `src/auth.ts` — device-flow login, workspace selection, token refresh, dynamic UA
- `src/models.ts` — model catalog
- `test/auth.test.ts` — bun test suite with mocked fetch

## Development

```sh
bun test
```

## License

MIT
