# API local của LioOps

Ngày cập nhật: 04/11/2026. B2 đưa các API của panel vào một đường gọi có tên; đây chưa phải giao thức relay hay kết nối máy từ website public.

## Luồng gọi

```text
Panel / workspace / replay
  → net/api.js (officeRequest, officeResource, lỗi EN/VI)
  → data/runtime.js (một OfficeClient và nguồn đang chọn)
  → data/client.js (quyền, nguồn, hủy và chặn phản hồi cũ)
  → data/local-api.js (method/path cố định, query/body, cookie/token cùng origin)
  → server/index.mjs (xác thực, Origin/Host, dự án/provider, quyền chi tiết)
```

`src/shared/contracts/api.js` là danh sách thao tác và validator tham số. Panel không nhận URL, method hoặc header do dữ liệu đầu vào chọn. Trường không khai báo, discriminant sai, body quá lớn hoặc operation không tồn tại bị chặn trước fetch. Backend tiếp tục kiểm tra nội dung, provider và giới hạn riêng; validation phía client không thay quyền server.

Nguồn `browser-log`, `demo` và trạng thái unpaired không có quyền gọi API PC. Toàn bộ operation HTTP trong bảng có implementation cho nguồn `local-http`. C bổ sung duy nhất `log.read` cho `encrypted-relay`, đọc cache đã giải mã tại browser; không gửi RPC hoặc URL API tới Connector. Mọi operation còn lại đều bị từ chối ở nguồn đó, kể cả khi giả capability. Không đổi điều kiện này thành proxy URL tùy ý.

Adapter C dùng [wire schema và quyền quan sát riêng](ENCRYPTED-OBSERVATION.md), chỉ bật `observe/content` sau khi xác thực peer, nhận snapshot đúng epoch/quyền và kiểm tra độ mới. Snapshot không thể tự khai thêm capability. Các frame `ready/seen` chỉ điều tiết dữ liệu quan sát, không phải API thực thi.

Cập nhật D (05/11/2026): cùng operation `log.read` có thể yêu cầu trích đoạn phiên theo ID opaque qua thông điệp mã hóa cố định `read {op:'log', id, requestId}`. Connector chỉ tìm trong catalog dự án đã cho phép, xác minh quyền nội dung/revision/epoch/input sequence và trả snapshot có tương quan. Không chuyển method/path/body HTTP qua relay. Browser coalesce lượt đọc, bỏ phản hồi phiên cũ và dọn cache khi mất độ mới hoặc đổi quyền. Các operation khác trong bảng vẫn chỉ có implementation local. Xem [phạm vi D](OBSERVATION-D.md).

## Quyền và vòng đời

- Nguồn local ban đầu chỉ có khả năng đọc. Quyền ghi, giao việc, duyệt và quản trị lấy từ snapshot backend đã xác thực; không lấy từ query, DOM hoặc metadata tự khai của panel.
- `localAdmin` thuộc máy local. Quyền giao việc/dừng/mở Codex thủ công và quyền duyệt trên điện thoại lấy từ hai lựa chọn chia sẻ riêng. `writeState` dành cho chat/ghi chú/thiết lập được backend cũ cho phép.
- Khi lỗi kết nối, quyền thực thi tạm dừng. Long-poll giữ cursor để nối lại; áp dụng quyền cuối cùng của cả batch trước callback UI. Snapshot thiếu thông tin quyền không kế thừa quyền thực thi trước đó.
- `can(name)` giúp hiển thị nút; request vẫn kiểm tra lại quyền và schema. Backend độc lập từ chối yêu cầu sai quyền kể cả khi client bị bỏ qua.
- Đổi nguồn hoặc đóng client hủy request đang chạy và làm phản hồi cũ không thể đọc qua `json()`. Reconnect stream/replay giữ context API, tránh hủy một yêu cầu giao việc đang chờ ACK.
- Timeout/hủy request không chứng minh tác vụ đã dừng. Request ghi không tự retry. Dispatcher giữ request ID/digest cũ; mất ACK chỉ tra biên nhận trên cùng context, không tra nhầm máy hoặc tạo ID mới.
- Ngoại lệ keepalive duy nhất là `presence.update` với `focused:false`: có thể gửi tới nguồn cũ khi đóng trang để nhả trạng thái đang xem. Kết quả vẫn bị bỏ sau khi context thay đổi.
- Lịch sử, prompt và ảnh không được ghi vào log của gateway. Session storage của dispatcher tiếp tục chỉ giữ UUID/digest theo origin, không giữ prompt/ảnh. Trước khi mở nhiều máy trên cùng website ở C phải thêm namespace theo danh tính thiết bị đã ghép.

## Ảnh và thao tác quản trị

`image.read` là resource local được kiểm tra qua cùng registry/capability. Builder chỉ trả đường dẫn ảnh cố định cùng origin, giữ lazy-loading của trình duyệt; nó không biến một operation thực thi thành URL tải tài nguyên. C không hỗ trợ ảnh remote. Relay sau này cần transport ảnh mã hóa riêng, cùng việc dọn state UI/ảnh khi đổi thiết bị.

Dọn máy và tự động đóng tiến trình chỉ được thao tác ở local: client tắt nút khi thiếu quyền và backend kiểm tra `isLoopback` cho `/api/sys/action`, `/api/sys/auto`. Người xem LAN đã đăng nhập vẫn đọc được số liệu. Quản trị tài khoản, tunnel, LAN, cài đặt desktop và các thao tác worktree tiếp tục giữ ranh giới local hiện có.

Các dòng `read` có thể vẫn cần `localAdmin` (ví dụ cấu hình tunnel). `execute` là nhóm điều khiển tác vụ/phê duyệt; presence dùng chung quyền `approve` vì tham gia giữ yêu cầu duyệt. Mỗi capability là giới hạn phía client, không phải credential truyền cho backend.

## Danh sách sinh từ mã

Chạy `node scripts/api-map.mjs` để cập nhật; `node scripts/api-map.mjs --check` để kiểm tra. Không sửa tay phần bảng.

<!-- api-map:start -->

| Operation | Method | Path | Access | Capability | Local only | Parameters |
| --- | --- | --- | --- | --- | --- | --- |
| `tasks.metadata` | GET | `/api/tasks` | read | accountQuota |  | — |
| `tasks.receipt` | GET | `/api/tasks/request` | read | observe |  | id |
| `workspace.read` | GET | `/api/workspace` | read | content |  | id, source |
| `log.read` | GET | `/api/log` | read | content |  | id, agent |
| `image.read` | GET | `/api/image` | read | content |  | id |
| `history.burn` | GET | `/api/burn` | read | observe |  | range |
| `history.wrapped` | GET | `/api/wrapped` | read | observe |  | — |
| `history.replay` | GET | `/api/replay` | read | content |  | day, from, to |
| `history.timeline` | GET | `/api/timeline` | read | content |  | from, to |
| `system.read` | GET | `/api/sys` | read | systemMetrics |  | open |
| `cache.read` | GET | `/api/cache` | read | observe |  | — |
| `quick.read` | GET | `/api/quick` | read | observe |  | — |
| `chat.read` | GET | `/api/chat` | read | content |  | — |
| `loop.read` | GET | `/api/loop` | read | observe |  | — |
| `tenure.read` | GET | `/api/tenure` | read | observe |  | — |
| `stranded.read` | GET | `/api/stranded` | read | content |  | — |
| `provider.version` | GET | `/api/claude-version` | read | observe |  | — |
| `tunnel.read` | GET | `/api/tunnel` | read | localAdmin | yes | — |
| `push.read` | GET | `/api/push` | read | observe |  | endpoint |
| `tasks.start` | POST | `/api/tasks` | execute | taskStart |  | requestId, text, sid, dir, task, agent, images, model, effort, fresh, chat, workspace, conversationId |
| `tasks.steer` | POST | `/api/tasks/steer` | execute | taskStart |  | requestId, text, sid, dir, task, agent, images, model, effort, fresh, chat, workspace, conversationId |
| `tasks.stop` | POST | `/api/tasks/stop` | execute | taskStop |  | id |
| `tasks.openCodex` | POST | `/api/tasks/open-codex` | execute | openApp |  | sid |
| `tasks.desktop` | POST | `/api/tasks/desktop` | admin | localAdmin | yes | on |
| `tasks.allow` | POST | `/api/tasks/allow` | admin | localAdmin | yes | on |
| `tasks.background` | POST | `/api/tasks/bg` | admin | localAdmin | yes | on |
| `prompt.rewrite` | POST | `/api/prompt/rewrite` | execute | taskStart |  | text, lang, photos |
| `permissions.answer` | POST | `/api/perm` | execute | approve |  | id, choice, answers, note |
| `presence.update` | POST | `/api/presence` | execute | approve |  | page, focused |
| `cache.write` | POST | `/api/cache` | admin | localAdmin | yes | nudge |
| `preferences.language` | POST | `/api/prefs` | write | writeState |  | lang |
| `quick.write` | POST | `/api/quick` | write | writeState |  | list |
| `todos.write` | POST | `/api/todos` | write | writeState |  | op, id, text, done |
| `loop.stop` | POST | `/api/loop` | execute | taskStop |  | op, id |
| `loop.hint` | POST | `/api/loop` | execute | taskStart |  | op, id, text |
| `loop.config` | POST | `/api/loop` | admin | localAdmin | yes | op, on, n, min |
| `tenure.config` | POST | `/api/tenure` | admin | localAdmin | yes | op, days |
| `tenure.official` | POST | `/api/tenure` | admin | localAdmin | yes | op, name |
| `tenure.farewell` | POST | `/api/tenure` | admin | localAdmin | yes | op, name |
| `stranded.open` | POST | `/api/stranded/open` | admin | localAdmin | yes | id |
| `stranded.remove` | POST | `/api/stranded/remove` | admin | localAdmin | yes | id |
| `session.open` | POST | `/api/open` | admin | localAdmin | yes | id |
| `system.action` | POST | `/api/sys/action` | admin | localAdmin | yes | action, target, start, items |
| `system.auto` | POST | `/api/sys/auto` | admin | localAdmin | yes | hours |
| `accounts.prepare` | POST | `/api/accounts` | admin | localAdmin | yes | name |
| `accounts.login` | POST | `/api/accounts/login` | admin | localAdmin | yes | name |
| `accounts.code` | POST | `/api/accounts/code` | admin | localAdmin | yes | name, code |
| `accounts.cancel` | POST | `/api/accounts/cancel` | admin | localAdmin | yes | name |
| `accounts.rename` | POST | `/api/accounts/rename` | admin | localAdmin | yes | name, label |
| `accounts.use` | POST | `/api/accounts/use` | admin | localAdmin | yes | name |
| `accounts.auto` | POST | `/api/accounts/auto` | admin | localAdmin | yes | on, move |
| `accounts.order` | POST | `/api/accounts/order` | admin | localAdmin | yes | order |
| `accounts.move` | POST | `/api/accounts/move` | admin | localAdmin | yes | id, to |
| `tunnel.write` | POST | `/api/tunnel` | admin | localAdmin | yes | on |
| `lan.write` | POST | `/api/lan` | admin | localAdmin | yes | on |
| `pin.rotate` | POST | `/api/pin` | admin | localAdmin | yes | pin |
| `pin.change` | POST | `/api/pin` | write | writeState |  | current, pin |
| `phone.approval` | POST | `/api/phone` | admin | localAdmin | yes | approve |
| `remoteControl.write` | POST | `/api/rc` | admin | localAdmin | yes | on |
| `chat.send` | POST | `/api/chat` | write | writeState |  | op, text, sticker, replyTo |
| `chat.react` | POST | `/api/chat` | write | writeState |  | op, id, emoji |
| `chat.vote` | POST | `/api/chat` | write | writeState |  | op, id, i |
| `chat.rsvp` | POST | `/api/chat` | write | writeState |  | op, id, yes |
| `chat.recall` | POST | `/api/chat` | write | writeState |  | op, id |
| `chat.poll` | POST | `/api/chat` | write | writeState |  | op, q, opts |
| `chat.photo` | POST | `/api/chat` | admin | localAdmin | yes | op, data |
| `chat.say` | POST | `/api/chat` | admin | localAdmin | yes | op, from, text, key, sticker, photo, pin, delay, react, reacts, answer |
| `push.add` | POST | `/api/push` | write | writeState |  | op, sub |
| `push.remove` | POST | `/api/push` | write | writeState |  | op, endpoint |
| `push.report` | POST | `/api/push` | write | writeState |  | op, why, detail |
| `push.test` | POST | `/api/push` | write | writeState |  | op, endpoint |

<!-- api-map:end -->

## Kiểm thử

- `tests/unit/office-api.test.mjs`: tham số, query/token, quyền, nguồn giả chỉ đọc, phản hồi muộn, reconnect độc lập API, timeout, không retry, keepalive và resource URL.
- `tests/unit/api-boundary.test.mjs`: AST kiểm tra panel/React component không có fetch, beacon, network client hoặc URL API PC trực tiếp.
- `tests/e2e/panel-api.spec.ts`: client/adapter thật gọi backend production riêng, thử đọc/ghi chat, todos, quick prompts, cache, ngôn ngữ và lịch sử; không chạy AI hoặc thao tác hệ điều hành.
- `tests/e2e/local-admin.spec.ts`: socket metadata trong child fixture giả lập người xem LAN qua listener loopback; thử PIN thật của fixture và gọi API trực tiếp. Không có cờ test/endpoint mới trong backend production, không bind ra LAN thật.
- Các bài workspace Codex/Claude, remote, replay/reconnect và prompt coach tiếp tục kiểm tra hành vi trên trình duyệt. Các ca AI dùng fixture, không dùng quota thật.

Public wire schema, xác thực ghép máy, E2EE, namespace dữ liệu theo thiết bị và bộ cài thuộc các mốc tiếp theo. Không xem các operation local là các lệnh đã được phép chuyển qua relay.
