# Rà soát trước khi tách web và Connector

Ngày: 03/11/2026. Phạm vi: nguồn dữ liệu, điểm gọi mạng, cấu hình, đóng gói và baseline kiểm thử. Đây là kiểm kê đầu vào cho [kế hoạch hiện hành](PUBLIC-BETA-PLAN.md), chưa phải chứng nhận bảo mật toàn bộ repo.

Mục 1–4 ghi baseline trước refactor; cập nhật triển khai ngày 04/11/2026 ở mục 5–7. Các nhận xét về static/demo trong baseline không mô tả mã B1 sau khi tách nguồn.

Cập nhật 05/11/2026: D bổ sung [quan sát theo dự án có quyền](OBSERVATION-D.md), giữ C/protocol 1 và backend local. Kết quả mới, phép đo và các ca vận hành chưa làm được ghi tại `test-results-release-checks/d-summary.json`; kiểm kê baseline bên dưới không phải mô tả giới hạn của D.

## 1. Kết luận từ mã đang có

| Quan sát | Bằng chứng | Hệ quả triển khai |
| --- | --- | --- |
| Trang chủ giữ văn phòng cũ | `app/page.tsx`, `src/components/OfficeShell.tsx` | Giữ nguyên scene/panel trong bước tách transport |
| Public build mới có cấu hình đầu tiên | `ConnectionSetup.tsx`, `OfficeBoot.tsx` | Chưa có handshake Connector; không dùng trạng thái local để khẳng định đã ghép web |
| Static export vẫn ép demo | `core/env.js`: `STATIC`; `demo/demo.js`: `DEMO = BROWSER_OBSERVER || STATIC || …` | Không coi build web thành công là đã có nguồn dữ liệu thật online |
| Kiểm tra cấu hình gọi `/api/tasks` cùng origin | `ConnectionSetup.tsx` | Chỉ chứng minh API local trả lời; nút tải hiện bị vô hiệu đúng trạng thái chưa có bộ cài |
| SSE/long-poll nằm trong module demo | `demo/demo.js`: `connect`, `ask`, `applyMsg` | Tách transport trước khi thêm relay; giữ nguyên xử lý sự kiện trong UI |
| 19 module UI gọi mạng trực tiếp | Danh mục mục 2, `rg` trên `src/office/ui` | Cần chuyển theo nhóm; thay stream đơn lẻ không làm toàn app hoạt động qua Connector |
| Giao việc có biên nhận bền vững | `server/task-requests.mjs`, `src/office/net/task-request.js` | Giữ request ID/đối chiếu sau mất ACK, không viết lại thành gửi lại tự động |
| Core server và Next đang liên quan | `server/index.mjs` | Connector phải tách core; không đóng gói nguyên server UI rồi gọi là agent nhẹ |
| Windows tự chạy nền hiện phụ thuộc repo/runtime bên ngoài | `bin/cli.mjs`, `bin/service.mjs`: Startup VBS | Chưa đáp ứng installer độc lập trên máy chưa cài Node |
| Google dịch mô tả đã mặc định tắt trong mã | `server/index.mjs`: `OFFICE_TRANSLATE === '1'` | Giữ mặc định; không gửi nội dung log qua dịch vụ dịch trong luồng Connector |
| Không có thư mục `.git` ở workspace này | Kiểm tra filesystem | Trước refactor cần checkpoint mã riêng và quy tắc phục hồi |

Không có module Connector/relay/bộ cài thực tế trong danh mục nguồn đã rà. Các thư mục nêu trong kế hoạch là thiết kế dự kiến, không được tính là triển khai xong.

## 2. Các module UI có điểm gọi mạng trực tiếp

Danh sách kiểm tra bằng `rg -l 'fetch\(|EventSource|sendBeacon|WebSocket' src/office/ui -g '*.js'`. Phân loại dưới đây định hướng migration, không tự cấp quyền remote cho API cũ.

| Module trong `src/office/ui/` | Dữ liệu/thao tác | Xử lý khi thêm remote |
| --- | --- | --- |
| `burn.js` | Số liệu sử dụng | Đọc, cần quyền và thời điểm nguồn |
| `cache-words.js` | Đọc/đổi thiết lập cache | Tách đọc và ghi |
| `codex-usage.js` | Metadata provider/hạn mức qua API tasks | Chuẩn hóa nguồn và độ mới, không đoán phần trăm |
| `group-chat.js` | Đọc/ghi chat Công ty | Dữ liệu PC, không thành phòng chat chung mọi người |
| `group-chat-view.js` | Chat, log, quick prompt, tasks, mở Codex | Tách đọc, thực thi và mở ứng dụng |
| `mac-drawer.js` | Số liệu máy, cleanup, quản lý tiến trình, tự động hóa | Chỉ số đọc có quyền riêng; hành động quản trị giữ local tới khi có thiết kế riêng |
| `notify.js` | Push registration | Chưa mang sang remote; quyết định riêng về quyền và metadata |
| `permissions.js` | Presence, duyệt lệnh, beacon khi đóng trang | Duyệt phải ràng buộc đúng task/request; không tự cho phép khi mất kết nối |
| `prompt-coach.js` | Rewrite gọi model | Là thao tác thực thi có quyền, không coi là đọc |
| `session-account.js` | Chuyển tài khoản | Giữ local |
| `session-drawer.js` | Log, mở ứng dụng | Quyền đọc nội dung và mở ứng dụng riêng |
| `settings.js` | Ghi cài đặt/ngôn ngữ | Phân biệt cấu hình browser và cấu hình PC |
| `stranded.js` | Phiên/công việc bị gián đoạn và thao tác khôi phục | Không tự chạy lại khi reconnect |
| `stuck.js` | Loop/stop/hint và cấu hình | Lệnh thực thi chỉ cho tác vụ được quản lý |
| `task-sheet.js` | Metadata tasks, lựa chọn mở desktop | Không dùng metadata endpoint để chứng minh đã ghép máy |
| `topbar.js` | Tunnel/push và cấu hình truy cập cũ | Giữ local; không đưa nguyên API quản trị lên relay |
| `whiteboard.js` | Todos | Đọc/ghi trạng thái tại PC |
| `workspace.js` | Hội thoại và giao việc riêng | Ưu tiên sau luồng quan sát; giữ lịch sử/biên nhận ở PC |
| `wrapped.js` | Tổng kết | Dữ liệu tổng hợp ở PC, gửi theo quyền |

Các điểm ngoài nhóm UI cũng phải tính:

- `demo/demo.js`: stream và long-poll live; `net/task-request.js`: gửi và đối chiếu công việc.
- `replay/replay.js`, `replay/timeline.js`: lịch sử và dòng thời gian.
- `people/farewell.js`, `people/interns.js`: lịch sử dự án và ghi trạng thái; `people/outings.js`: kiểm tra phiên bản Claude.
- `life/weather.js`: gọi Open-Meteo khi chọn thành phố; không gửi log/prompt. Cần giữ là lựa chọn rõ ràng.
- `ConnectionSetup.tsx`: kiểm tra API local hiện tại.
- `world/backdrops/shops.js`, `street-life.js`: tải asset; không nhầm với RPC điều khiển.
- `app/layout.tsx`: QR library hiện được phục vụ từ asset local, không cần script CDN.

Trước khi bật từng tính năng remote, bổ sung vào contract danh sách method/schema, quyền, giới hạn và kiểm tra tương ứng tại Connector. Một hàm `fetch(url)` tổng quát đi qua relay không đáp ứng ranh giới này.

## 3. Kiểm thử chạy lại ở lượt rà soát này

| Kiểm tra | Kết quả |
| --- | --- |
| Unit trong `tests/unit/*.test.mjs`, chạy serial | 176 bài: 173 đạt, 3 bỏ qua, 0 lỗi |
| `npm.cmd run lint` | Đạt |
| `npm.cmd run typecheck` | Đạt; JavaScript hiện có `checkJs: false`, không coi là đã typecheck toàn bộ JS |

Log máy phát triển ở `test-results-release-checks/unit-baseline.log`, `lint-baseline.log`, `typecheck-baseline.log` (git-ignored, không chứa dữ liệu AI thật từ lượt kiểm tra này).

Build EN/VI, luồng cấu hình và các E2E Codex/remote đã có kết quả từ lượt trước; không chạy lại trong lượt chỉ rà soát/tài liệu này và không tính là nghiệm thu kiến trúc Connector. Một số bài cũ trong `office.spec.ts` và `steer.spec.ts` còn bám màn giao việc trước khi có workspace, cần xử lý trong baseline hồi quy trước refactor liên quan.

## 4. Phạm vi thay đổi ở lượt này

Hợp nhất kế hoạch web online + Connector, lưu kế hoạch cũ để tra cứu, cập nhật mô tả kiến trúc và ghi kiểm kê này. Không thay logic production, không dừng/restart app local đang chạy, không chuyển/xóa lịch sử, không tạo thêm màn hình hoặc bộ cài giả.

Checkpoint cục bộ: `test-results-release-checks/source-before-web-connector-20261103-091131.zip`; manifest cùng tên đuôi `.json`. Archive có 507 entry, 11.160.116 byte; đã so SHA-256 với nguồn của trang chủ, OfficeShell, ConnectionSetup, server, lockfile và logo gốc. Chỉ gồm source/test/docs/public asset và cấu hình build được chọn; không gồm `data`, credential store, `.env`, dependencies hoặc build output. Đây là bản sao mã trước refactor, không phải backup toàn bộ máy hoặc toàn bộ dữ liệu ứng dụng.

Chưa chứng minh kết nối từ web hosting thật tới PC, isolation hai máy, pairing/E2EE, cài trên Windows mới hoặc hiệu năng agent. Đây là các cổng nghiệm thu phải thực hiện, không được suy ra từ unit/lint/typecheck.

## 5. Cập nhật B1 — 04/11/2026

- `data/client.js` quản lý một subscription và vô hiệu callback cũ khi đóng/đổi nguồn.
- `data/local-http.js` nhận SSE hoặc long-poll từ API local, giữ nguyên payload. Long-poll có deadline, cursor, backoff, hủy request và chờ visibility; 401/403 dừng. Đợi snapshot hợp lệ trước khi báo đã nhận dữ liệu.
- `net/connection.js` nối dữ liệu vào `applyMsg` cũ; replay ngắt/nối lại qua cùng client. Adapter không có phương thức gửi lệnh.
- `shared/office-source.js` tách nguồn khỏi format build. `build:web` mặc định unpaired, không boot engine khi chưa có nguồn; `?demo` mới mở mẫu. Script demo cũ chủ động đặt `OFFICE_DEMO=1`.
- Khung packet version/capability là contract nội bộ của backend cũ. Không gửi legacy snapshot (có thể mang metadata local) vào relay hoặc xem validation này là ranh giới bảo mật remote.
- Unit: 189 bài, 186 đạt/3 bỏ qua/0 lỗi. Lint/typecheck/build local riêng và export EN/VI đạt. Bốn E2E tasks/remote cũ, hai E2E live mới (SSE/poll, reconnect/thoát replay), bốn E2E public web (EN/VI và đọc log chỉ đọc) đạt; đây là 10 bài chọn theo phạm vi, không phải toàn bộ E2E suite. Báo cáo ở `test-results-release-checks/b1-summary.json`.

Lượt đầu bài live dùng nhầm provider session ID thay vì ID phiên do Office cấp; fixture đã sửa để lấy ID thật qua API. Chromium giữ SSE đang mở khi mô phỏng offline nên ca SSE dùng loopback proxy để ngắt TCP thực; backend production không có endpoint phục vụ kiểm thử này. Các ca sau sửa fixture đã đạt; không che lỗi bằng sửa trạng thái DOM hoặc ép click.

Ở mốc B1 các API panel trong mục 2 chưa chuyển; B2 được cập nhật ở mục 6. Không có Connector/relay/bộ cài phát sinh từ B1.

## 6. Cập nhật B2 — 04/11/2026

- Đã chuyển 19 module UI trong mục 2, cùng các caller replay/timeline/tenure/provider-version và ConnectionSetup sang named API. Resource ảnh đi qua registry, không còn URL API trực tiếp trong panel.
- Registry `shared/contracts/api.js` có 71 thao tác; local transport sở hữu URL/method/token/header và không tự retry request ghi. Source/capability/schema được kiểm tra trước fetch; backend tiếp tục xác thực độc lập.
- Context API tồn tại độc lập stream. Reconnect/thoát replay không hủy task đang chờ ACK; đổi nguồn làm response và body cũ bị từ chối. Dispatcher không tra biên nhận trên nguồn khác.
- Snapshot xác nhận quyền ghi/thực thi. Long-poll áp dụng grant cuối batch trước callback UI, tạm dừng thực thi khi mất kết nối và không giữ grant nếu snapshot mới thiếu thông tin quyền.
- Backend `/api/sys/action`, `/api/sys/auto` nay yêu cầu loopback; người xem LAN vẫn được đọc metrics. Các nút quản trị máy phía UI dùng capability thật.
- `tests/unit/api-boundary.test.mjs` kiểm tra AST để chặn raw fetch/beacon/network client và URL API trong UI/components. Bảng [API contract](API-CONTRACT.md) sinh từ registry, có lệnh kiểm tra chống lệch tài liệu.
- Unit: 202 bài, 199 đạt/3 bỏ qua/0 lỗi. Lint không warning, typecheck/build local riêng và export EN/VI đạt; 11 E2E local và 4 E2E public web đạt. Đây là 15 bài chọn theo phạm vi, không phải toàn bộ E2E suite. Bằng chứng ở `test-results-release-checks/b2-summary.json`.

Checkpoint trước B2: `test-results-release-checks/source-before-b2-20261104-033256.zip`, SHA-256 `41275082D198C9612EA5D29016EA5DA5A60ADEE5767A8541B1E8E2F1F699A59F`. Không chứa lịch sử người dùng/credential/dependencies/build output. Các ca kiểm tra dùng home/data riêng và fixture AI; chỉ đọc số liệu OS, không chạy model thật hoặc thao tác dọn máy thật.

Đây vẫn là contract cho backend legacy đã xác thực. C cần public schema, Project ID thay đường dẫn máy, namespace pending request theo thiết bị, dọn state UI theo thiết bị và transport ảnh mã hóa. Không bật relay bằng cách cho forward toàn bộ registry hoặc snapshot legacy.

## 7. C — 04/11/2026

Đã bổ sung `src/shared/remote/`, `connector/`, `relay/` và adapter browser có hành vi thật; xem [giới hạn và giao thức](ENCRYPTED-OBSERVATION.md). Không tái dùng snapshot legacy làm payload relay. Nội dung đi qua JWS nằm trong JWE; khóa peer xác minh từ invitation trên PC và mã browser được chủ PC duyệt. Public Project ID ngẫu nhiên không ánh xạ thành đường dẫn do browser gửi.

Một file được cấp quyền rõ, kiểm tra realpath/dev/ino đầy đủ và giới hạn đọc. Không import server local vào Connector hoặc sao chép lịch sử/đăng nhập provider. Hành động quản trị/giao việc/rewrite/ảnh không có handler remote. Lệnh `log.read` duy nhất ở browser chỉ đọc cache; không có pending request thực thi remote cần namespace ở C. Cần namespace riêng trước khi mở E hoặc nhiều thiết bị.

Kiểm thử dùng file fixture tại home riêng, relay và PC consent thật trên listener riêng; không gửi dữ liệu người dùng tới relay public. Có kiểm tra fake key, sửa bản mã, replay/epoch/sequence/quyền/scope, auth/origin, backpressure, race lưu approval/thu hồi/quên và lỗi ghi đĩa. Kết quả: 219 unit (216 đạt/3 bỏ qua), 5 E2E web, 4 E2E local, lint không warning, typecheck và hai loại build đạt. Một lượt E2E riêng cũng đạt qua relay HTTPS Quick Tunnel có xác minh TLS; chỉ chia sẻ bản mã của fixture, web vẫn là preview loopback. Hardening quên máy sau lượt HTTPS được kiểm tra ở unit/public-web bản cuối. Báo cáo ở `test-results-release-checks/c-summary.json`; chưa chứng minh hai PC cách ly, website đã deploy hoặc phiên người dùng thật.

Ca browser đầu phát hiện drawer chưa nạp lại log mới. Ca HTTPS tiếp đó phát hiện queue đầy khi dựng cảnh và timeout 15 giây quá ngắn cho poll/receipt trên mạng thử. Đã sửa reload drawer, handshake `ready`, receipt `seen` với một snapshot chờ nhận, budget độ mới 30 giây/receipt 45 giây và phục hồi drawer theo đúng context sau khi nhận dữ liệu mới. Không tăng giới hạn tuổi/chữ ký để nhận thông điệp sai. Bộ kiểm tra không ép DOM hoặc bỏ kiểm tra quyền để đạt.

Checkpoint trước C: `test-results-release-checks/source-before-c-20261104-121225.zip`, SHA-256 `FB90FAED40C789B323D37A05DF0C4B6388158E132ECC3DCAA59FD46770C50A06`. Không gồm dữ liệu cá nhân, credential, dependencies hoặc build. App local cũ không được restart; build/test dùng output, cổng và dữ liệu riêng.
