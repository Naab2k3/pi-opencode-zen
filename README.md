# pi-opencode-zen

[Pi](https://pi.dev) provider extension for [OpenCode Zen](https://opencode.ai/docs/zen) — device-flow OAuth login with your OpenCode workspace account, no API key management needed.

Works for workspace **members**: `/login opencode-zen` opens the OpenCode device-code page, you approve in the browser, and pi stores/refreshes the OAuth token itself. If your account belongs to multiple workspaces, pi asks you to pick one; requests carry the matching `x-opencode-org-id` header.

## Install

```sh
pi install git:github.com/Naab2k3/pi-opencode-zen@v1.0.0
```

Published on npm as `opencode-zen-oauth` (the `pi-opencode-zen` name is taken by a deprecated anonymous-tier extension):

```sh
pi install npm:opencode-zen-oauth
```

Or clone into your pi extensions directory manually and restart pi (or `/reload`).

## Requirements

No opencode install needed. Everything runs over HTTPS: the device-code login opens in your browser for a one-time approval, and pi stores and refreshes the token itself. You only need an OpenCode account in the workspace you want to use.

## Security

- The extension never prints or logs your token or workspace ID. If you need to
  share debug output, it is safe as-is.
- Do not paste your token or workspace ID into chat yourself — pi session files
  persist what you type. If one leaks, revoke it in the OpenCode console
  (`API keys` / workspace settings) and run `/login opencode-zen` again.
- Login and token refresh run entirely over HTTPS against `opencode.ai`.

## Usage

```
/login opencode-zen        # device-flow OAuth via opencode.ai console
/model opencode-zen/glm-5.3-flash
```

Fallback: set `OPENCODE_API_KEY` to use a Zen API key instead of OAuth.

## Models

The catalog refreshes automatically from the workspace (`fetchModels`): every model the workspace allows — not disabled and on the org whitelist — appears in `/model`, with context limits and prices mapped from the console config. The static `MODELS` in `src/models.ts` is only the offline baseline.

Note: the Zen edge serves the inference API only to opencode clients, so the extension sends an opencode `User-Agent` (resolved from the npm registry).

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
