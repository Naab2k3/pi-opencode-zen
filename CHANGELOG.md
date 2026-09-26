# Changelog

## 1.2.2

### Changed
- Rewrote README (hook-first structure) and added Vietnamese translation
  (`README.vi.md`) with a language switcher. No code changes.

### Fixed
- Console API calls use the `x-org-id` header. The previous `x-opencode-org-id`
  header is only valid on the inference endpoint — on `/api/config` the console
  answers `400 OrgRequired`. Shared workspace tokens (with a server-side active
  org) masked this; fresh device-flow tokens exposed it.
- `fetchZenModels` failure now hints at re-login (`/login opencode-zen`) on
  token rejection instead of a bare HTTP status.

### Added
- Security notes in README (no token/workspace-ID logging, leak recovery).

## 1.1.1

### Changed
- Versionless `User-Agent` (`opencode/cli`). The npm `latest` dist-tag tracks the
  v1 line which the console rejects, and pinning a local version drifts — the
  console accepts the versionless form, verified live.

## 1.1.0

### Added
- Dynamic model catalog via `fetchModels`: the workspace-allowed list
  (not disabled, on the org whitelist, no custom provider override) is pulled
  from `/api/config` on every pi catalog refresh, with context limits and
  prices mapped by `modelFromZen`. The static `MODELS` remains as the offline
  baseline.

## 1.0.1

### Added
- `repository` / `homepage` metadata so the pi package gallery links GitHub.

## 1.0.0

### Added
- `opencode-zen` provider for pi: console device-flow OAuth login, no API key
  management. Workspace members approve once in the browser.
- Workspace selection in the pi TUI after approval; requests carry the
  matching org header.
- Workspace-allowed model check after login and on every token refresh;
  `filterModels` narrows `/model` to what the workspace permits.
- Dynamic opencode `User-Agent` (later replaced, see 1.1.1).
- Paid-tier prices from the console workspace config
  (glm-5.3-flash, deepseek-v4.1-flash).
