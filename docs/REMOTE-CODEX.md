# Gửi prompt từ web tới Codex trên PC

LioOps chạy trên PC Windows, cùng Codex và thư mục dự án. Cloudflare Quick Tunnel cung cấp địa chỉ HTTPS để mở từ điện thoại hoặc máy khác. Không cần deploy bản Next.js riêng để dùng cách này.

PC phải bật, có mạng và không ở chế độ ngủ. Windows hiện không được LioOps tự giữ thức. Khi PC offline, web không thể giao việc cho Codex; không có hàng đợi tự chạy sau khi máy trở lại.

## Chạy và mở từ xa

Tại thư mục repo, dùng PowerShell:

```powershell
npm.cmd run build
npm.cmd start
```

1. Mở `http://localhost:4310` trên PC. Kiểm tra Codex đã được nhận diện; xem [hướng dẫn Codex](CODEX.md) nếu chưa đăng nhập CLI.
2. Mở **Cài đặt → Điện thoại → Khi ra ngoài** và bật **Dùng khi ra ngoài (qua Cloudflare)**. Lần đầu có thể tải chương trình `cloudflared` từ nguồn Cloudflare.
3. Trên PC, bật **Giao việc cho AI từ xa**. Quyền này mặc định tắt. Bật **Duyệt lệnh từ điện thoại** nếu muốn duyệt và trả lời câu hỏi từ xa.
4. Trên điện thoại hoặc máy khác, mở địa chỉ HTTPS được hiển thị, nhập PIN. Không chia sẻ PIN hay địa chỉ truy cập.
5. Bấm **Giao việc AI** trên thanh trên cùng hoặc mục **AI** ở thanh dưới điện thoại, chọn trợ lý và dự án, nhập prompt rồi gửi. Model và mức suy luận nằm trong phần tùy chọn. Hội thoại, tiến trình, thẻ duyệt và nút dừng ở cùng màn hình; nhóm **Công ty** dành cho trò chuyện riêng.
6. Tắt công tắc Cloudflare trên PC khi muốn đóng đường truy cập. Listener từ xa và các kết nối đang mở sẽ đóng; tiến trình tunnel do LioOps quản lý sẽ được dừng.

Chỉ chọn được dự án PC đã nhận diện, không nhập đường dẫn máy tính tùy ý từ web. Hội thoại Codex bên ngoài được tạo bản sao trước khi tiếp tục; các hội thoại do LioOps quản lý có thể được tiếp tục trong cùng dự án. Sandbox và phê duyệt của Codex vẫn áp dụng. Lệnh được đánh dấu rủi ro không thể cho phép từ xa.

Quick Tunnel dùng địa chỉ tạm thời. Restart LioOps có thể giữ địa chỉ nếu helper còn chạy và xác minh được danh tính tiến trình; tắt tunnel hoặc restart PC sẽ tạo địa chỉ khác. Bản cũ chỉ lưu PID mà không có thông tin xác minh có thể báo lỗi: đóng `cloudflared` cũ trong Task Manager trên PC rồi tắt/bật lại. LioOps không dừng một PID chưa xác minh.

Có thể tắt ngay trong lúc đang tải hoặc kết nối. Việc tải được hủy, file chưa tải xong không trở thành chương trình đã cài. Nếu mạng chặn UDP và chế độ tự động không kết nối được, có thể đặt `$env:OFFICE_TUNNEL_PROTOCOL='http2'` trước `npm.cmd start`; mặc định là `auto`, các giá trị hỗ trợ gồm `auto`, `http2`, `quic` theo [tài liệu Cloudflare](https://developers.cloudflare.com/tunnel/reference/run-parameters/#protocol).

## Mất mạng, tải lại trang và chống chạy trùng

Mỗi lần giao việc hoặc chen lời từ giao diện có một UUID. Server ghi biên nhận trước khi gọi trợ lý; gửi lại cùng mã và nội dung không thực thi lần thứ hai. Biên nhận tồn tại qua restart LioOps.

- Mất phản hồi: giao diện chỉ đọc trạng thái để đối chiếu, không tự gửi lại prompt.
- Khi dùng HTTPS hoặc localhost và trình duyệt cho phép session storage, tab giữ mã cùng SHA-256 của nội dung chưa xác nhận. Prompt, ảnh và thông tin đăng nhập không được lưu trong mục này. Tải lại cùng tab và gửi lại nội dung, lựa chọn dự án/model giống hệt sẽ dùng lại mã.
- Nếu trình duyệt HTTPS chặn ghi session storage, biểu mẫu báo lỗi và không gửi prompt cho tới khi lưu được mã yêu cầu.
- Trên HTTP mạng nhà không có Web Crypto, cơ chế nhớ yêu cầu chỉ tồn tại trong trang đang mở. Dùng HTTPS để phục hồi sau khi tải lại trang. Đóng tab, xóa dữ liệu trình duyệt hoặc thay đổi nội dung có thể tạo một yêu cầu khác; kiểm tra lịch sử trước khi giao lại việc chưa xác nhận.
- Nếu server dừng sau khi nhận việc nhưng trước khi ghi phản hồi, biên nhận có trạng thái **chưa xác nhận**. Server không phát lại yêu cầu đó. Kiểm tra tác vụ/hội thoại trên PC trước khi tạo một việc mới.
- Không tự xóa `data/task-requests.json` để thử lại: việc đó làm mất lịch sử chống trùng. Nhật ký chỉ giữ mã, hash, thời điểm và thông tin tác vụ tối thiểu, không giữ prompt/ảnh/đăng nhập. Giới hạn 10.000 biên nhận; đạt giới hạn thì dừng nhận yêu cầu mới, không âm thầm xóa mã cũ.

Nhật ký này dành cho một instance LioOps với một thư mục dữ liệu riêng. Các instance ở cổng khác phải có `OFFICE_DATA_DIR` riêng.

## Hợp đồng API cho client khác

`POST /api/tasks` nhận `requestId` là UUID v4, cùng `agent`, `dir` hoặc `sid`, `text` và các lựa chọn hiện có. `POST /api/tasks/steer` cũng hỗ trợ cùng cơ chế. Client từ xa bắt buộc có mã; client localhost cũ không gửi mã vẫn tương thích nhưng không có biên nhận chống trùng. Mọi lần thử lại phải giữ nguyên mã và nội dung.

`GET /api/tasks/request?id=<UUID>` cần đăng nhập và quyền giao việc đang bật. Các trạng thái:

| Trạng thái | Ý nghĩa |
| --- | --- |
| `pending` | LioOps đang xử lý yêu cầu |
| `done` | Đã ghi phản hồi nhận việc/từ chối; `result.task.id` xác định tác vụ nếu được nhận. Không có nghĩa Codex đã hoàn thành |
| `uncertain` | Chưa xác nhận kết quả nhận việc; không được tự phát lại |

Một mã đi cùng nội dung khác trả `409 requestConflict`. Nhật ký lỗi/không ghi được trả `503 requestStore` trước khi tạo việc mới. Việc thu hồi quyền từ xa có hiệu lực cả với yêu cầu lặp và API tra cứu biên nhận.

## Kiểm thử và phạm vi xác nhận

```powershell
node --test --test-concurrency=1
npx.cmd playwright test tests/e2e/remote-codex.spec.ts tests/e2e/codex.spec.ts --workers=1
```

Kiểm thử tự động dùng dữ liệu tạm, Codex App Server giả lập và helper tunnel Node chạy được trên Windows. Kiểm tra listener từ xa thật, PIN, origin/host, quyền, giao việc, chen lời, duyệt/từ chối, câu hỏi, dừng, chống gửi trùng, mất phản hồi/tải lại trang và restart. Proxy HTTPS trong bài kiểm thử chỉ chạy bên trong Playwright; không mở ứng dụng ra Internet, không dùng tài khoản hay dự án cá nhân.

Kiểm thử ngày 02/11/2026 trên Windows bao gồm trường hợp trình duyệt chặn session storage thì không gửi prompt, tắt tunnel lúc đang khởi động và từ chối nhận/dừng PID không khớp danh tính. Bản hiện tại có 146 unit test: 143 đạt, 3 bỏ qua theo nền tảng. Các bài listener cũng bao phủ cấu hình tên miền cố định và yêu cầu JWT Access hợp lệ ngoài PIN.

### Kiểm thử HTTPS và Codex thật

```powershell
npm.cmd run test:codex:remote:live -- --run
```

Đây là kiểm thử chủ động dùng đăng nhập CLI và quota model hiện có. Không có `--run` thì chỉ in hướng dẫn. Runner khởi động Office với dữ liệu riêng, mở Quick Tunnel HTTPS thật và thao tác bằng trình duyệt thật; không giả lập API/model/đường truyền. Dự án mẫu và báo cáo nằm trong `test-results-codex-live/ui-*`; không sửa dự án sản phẩm. PIN/cookie/đăng nhập không vào báo cáo. Kết thúc runner sẽ tắt tunnel và archive riêng các hội thoại mẫu do nó tạo.

Ngày 02/11/2026, lượt HTTPS thật trên Windows với CLI 0.166.0 đạt **4/4 ca**: sửa file và chạy 3 test; tiếp tục cùng hội thoại để thêm giảm giá và chạy 4 test; từ chối lệnh và xác nhận marker không tồn tại; dừng lệnh thật và đợi qua thời điểm dự kiến ghi file để xác nhận không còn chạy. Bốn lần gửi lặp cùng mã đều trả lại cùng tác vụ. Đăng nhập PIN, chặn người chưa đăng nhập/token LAN/origin khác, kết nối lại trình duyệt và đóng tunnel sau kiểm thử cũng đạt.

Có thể thêm `--scenario=stop` để chỉ kiểm tra lệnh Dừng, hoặc `--scenario=usage` để xem token/quota thật mà không bắt đầu lượt model. Runner ghi `physical4GTest: false`: đi qua HTTPS Cloudflare thật từ PC chưa thay cho thử trên điện thoại ở mạng khác.

### Bước xác nhận trên điện thoại 4G

Phần còn cần thiết bị của chủ máy: bật tunnel trong Office thật, tắt Wi-Fi điện thoại để dùng 4G, mở URL HTTPS và nhập PIN. Giao một việc nhỏ trong dự án thử, kiểm tra file trên PC, thử duyệt/từ chối và Dừng; bật/tắt chế độ máy bay rồi mở lại để kiểm tra lịch sử. Không giao lại nội dung chưa xác nhận bằng một việc mới. Tắt công tắc tunnel trên PC để kết thúc và kiểm tra điện thoại không còn truy cập được. Các bài tự động chưa được ghi là đã hoàn thành bước này.

Theo lựa chọn hiện tại, dùng HTTPS tạm trước. Mã cho tên miền cố định/Cloudflare Access đã được chuẩn bị nhưng chưa cấu hình hay kích hoạt trên tài khoản thật; xem [cấu hình managed tunnel](REMOTE-MANAGED.md) khi có tên miền. Giao diện cloud với chương trình kết nối PC vẫn là nhánh riêng trong [kế hoạch triển khai](REMOTE-CODEX-PLAN.md). Deploy `OFFICE_STATIC=1` chỉ tạo demo, không điều khiển Codex trên PC.
