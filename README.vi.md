# opencode-zen-oauth

[![npm downloads](https://img.shields.io/npm/dm/opencode-zen-oauth?label=downloads)](https://pi.dev/packages/opencode-zen-oauth?name=opencode-zen-oauth)

[![Package on Pi](./assets/pi-dev-package.png)](https://pi.dev/packages/opencode-zen-oauth?name=opencode-zen-oauth)

**[English](./README.md)** | **Tiếng Việt**

Dùng OpenCode Zen trong pi — khỏi cần API key. Bạn là member (không phải owner) của workspace? Extension này sinh ra cho bạn.

## Cài đặt

```sh
pi install npm:opencode-zen-oauth
```

## Vì sao có extension này

Console v2 của OpenCode giấu API key với member, còn token OAuth đem gọi thẳng thì bị từ chối ngoài client chính chủ. Ba bức tường, một extension gỡ hết:

1. **Khỏi quản lý key.** `/login opencode-zen` hiện trang device-code, bạn approve một lần trên browser, pi tự lưu và tự refresh token.
2. **An toàn theo workspace.** Approve xong về terminal chọn workspace (cứ để trang web ở "All workspaces"). Mọi request tự gắn đúng header org, `/model` chỉ hiện model mà workspace đó cho phép. Xài thêm workspace nữa? `/opencode-zen switch-org` là xong, khỏi login lại (chỉ có hiệu lực trong session; muốn giữ sau restart thì login lại).
3. **Danh sách model tự cập nhật.** Model list refresh từ chính workspace — model bị disable hay ngoài whitelist của admin tự biến mất, context limit và giá/1M token map tự động. Discovery mà trục trặc, pi vẫn hiện list cũ thay vì trắng trang.

Gateway thỉnh thoảng trả 502/503? Extension tự retry với backoff trước khi bạn kịp thấy lỗi. Claude đời mới (Haiku 5.5, Sonnet/Opus 5.x, Fable 5) được gửi đúng dạng adaptive thinking mà gateway yêu cầu.

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
| `mimo-v2.6-flash-free` | $0 | $0 | $0 | text |

Giá/1 triệu token, tính vào workspace đã chọn. Các dòng zero-cost là
free tier của Zen: extension gửi đúng identity headers mà gateway yêu cầu
(xem `src/free-tier.ts`) và request đi qua nguyên bản, nên tool calling
chạy native trên các model đó. Route cũng được re-derive từ mã mỗi lần
đọc, nên cache danh sách model cũ (models-store.json) không ghim sai
protocol được.

## Bảo mật

- Extension không bao giờ in hay log token và workspace ID của bạn.
- Đừng tự paste token hay workspace ID vào chat — pi lưu session file những gì bạn gõ. Lỡ lộ thì revoke trong console OpenCode rồi `/login opencode-zen` lại.

## Cấu trúc

- `index.ts` — entry point pi load; re-export `src/extension.ts`
- `src/extension.ts` — ráp provider và đăng ký
- `src/auth.ts` — login device-flow, chọn workspace, refresh token
- `src/models.ts` — map model từ console sang pi, wire protocol từng route
- `src/retry.ts` — retry có giới hạn cho lỗi transient và option bị từ chối
- `src/commands.ts` — lệnh `/opencode-zen` (status, switch-org)
- `src/free-tier.ts` — identity headers cho free-tier
- `test/` — bộ test bun với fetch giả (`bun test`)
- `test/` — test suite bun với fetch mock (`bun test`)

## License

MIT

## Changelog

Xem [CHANGELOG.md](./CHANGELOG.md) và
[GitHub releases](https://github.com/Naab2k3/pi-opencode-zen/releases).
