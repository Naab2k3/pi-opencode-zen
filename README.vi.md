# opencode-zen-oauth

[![npm downloads](https://img.shields.io/npm/dm/opencode-zen-oauth?label=downloads)](https://pi.dev/packages/opencode-zen-oauth?name=opencode-zen-oauth)

[![Package on Pi](./assets/pi-dev-package.png)](https://pi.dev/packages/opencode-zen-oauth?name=opencode-zen-oauth)

**[English](./README.md)** | **Tiếng Việt**

Dùng OpenCode Zen trong pi — khỏi cần API key. Member trong workspace cũng xài được.

## Cài đặt

```sh
pi install npm:opencode-zen-oauth
```

## Vì sao có extension này

Console v2 của OpenCode giấu API key với member, còn token OAuth đem gọi thẳng thì bị từ chối ngoài client chính chủ. Ba bức tường, một extension gỡ hết:

1. **Khỏi quản lý key.** `/login opencode-zen` hiện trang device-code, bạn approve một lần trên browser, pi tự lưu và tự refresh token.
2. **An toàn theo workspace.** Approve xong về terminal chọn workspace (cứ để trang web ở "All workspaces"). Mọi request tự gắn đúng header org, `/model` chỉ hiện model mà workspace đó cho phép.
3. **Danh sách model tự cập nhật.** Model list refresh từ chính workspace — model bị disable hay ngoài whitelist của admin tự biến mất, context limit và giá/1M token map tự động.

## Đăng nhập

```
/login opencode-zen        # device code + link hiện trong TUI
```

Approve trên browser, quay lại terminal chọn workspace, xong. Model nằm dưới `opencode-zen/` trong `/model`. Không cần cài opencode — tất cả chạy qua HTTPS tới `opencode.ai`.

Dự phòng: set `OPENCODE_API_KEY` để dùng Zen API key thay vì OAuth.

## Models

Ví dụ thật từ một workspace (list của bạn tùy theo workspace):

| id | input | output | cache read | inputs |
|----|-------|--------|------------|--------|
| `glm-5.3-flash` | $0.15 | $0.50 | $0.03 | text, image |
| `deepseek-v4.1-flash` | $0.30 | $1.20 | $0.006 | text, image |
| `big-pickle` | $0 | $0 | $0 | text |
| `muse-spark-1.3-contributor-free` | $0 | $0 | $0 | text, image |

Giá/1 triệu token, tính vào workspace đã chọn. Các dòng zero-cost là
free tier của Zen: extension thỏa mãn content gate của gateway (marker
prompt + shape lịch sử, xem `src/v2-gate.ts`) và chạy tool calling qua
text protocol trên các model đó.

## Bảo mật

- Extension không bao giờ in hay log token và workspace ID của bạn.
- Đừng tự paste token hay workspace ID vào chat — pi lưu session file những gì bạn gõ. Lỡ lộ thì revoke trong console OpenCode rồi `/login opencode-zen` lại.

## Cấu trúc

- `index.ts` — entry point pi load; re-export `src/extension.ts`
- `src/extension.ts` — ráp provider và đăng ký
- `src/auth.ts` — login device-flow, chọn workspace, refresh token
- `src/models.ts` — map model từ console sang pi, wire protocol từng route
- `src/free-tier.ts` — identity headers cho free-tier
- `src/v2-gate.ts` — content gate free-tier: marker prompt, shape lịch sử, text-protocol tools
- `test/` — test suite bun với fetch mock (`bun test`)

## License

MIT

## Changelog

Xem [CHANGELOG.md](./CHANGELOG.md) và
[GitHub releases](https://github.com/Naab2k3/pi-opencode-zen/releases).
