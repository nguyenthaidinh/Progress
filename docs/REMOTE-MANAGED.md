# Tên miền cố định và Cloudflare Access

Tùy chọn cho giai đoạn sau. Hiện chủ máy chọn dùng [HTTPS tạm](REMOTE-CODEX.md), chưa có tài khoản/tên miền Cloudflare. Phần này chưa được kích hoạt trên dịch vụ thật.

LioOps hỗ trợ remotely managed tunnel, hostname HTTPS được cấu hình rõ ràng và xác minh JWT Cloudflare Access ngay tại listener từ xa. Access không thay PIN hay quyền giao việc/phê duyệt của Office. Token tunnel ở file cục bộ; không chuyển vào giao diện, đối số lệnh chứa token, lịch sử shell hay nhật ký Office.

## Khi đã có tài khoản và tên miền

1. Trong Cloudflare tạo remotely managed tunnel và public hostname, ví dụ `office.example.com`.
2. Trỏ service tới **`http://127.0.0.1:4317`** với cấu hình mặc định của Office. Đây là listener từ xa; không trỏ tới cổng chủ máy `4310`, không ghi đè HTTP Host thành localhost. Nếu đổi `OFFICE_PORT`, listener mặc định là cổng đó + 7; có thể đặt `OFFICE_TUNNEL_PORT` riêng.
3. Tạo ứng dụng Access loại self-hosted cho toàn bộ hostname, cho phép tài khoản/email của chủ máy. Giữ cả API và asset trong phạm vi bảo vệ, không tạo đường dẫn bypass. Lấy team domain và Application Audience (AUD).
4. Lưu riêng tunnel token vào `data/cloudflare-token.txt` trên PC bằng trình soạn thảo, không dán token vào chat hay lệnh shell. Thư mục `data/` được loại khỏi Git. Cần bản `cloudflared` hỗ trợ `--token-file` (2025.4.0 trở lên).
5. Đặt cấu hình trước khi chạy Office:

```powershell
$env:OFFICE_PUBLIC_URL='https://office.example.com'
$env:OFFICE_TUNNEL_TOKEN_FILE=(Resolve-Path '.\data\cloudflare-token.txt').Path
$env:OFFICE_ACCESS_TEAM_DOMAIN='https://your-team.cloudflareaccess.com'
$env:OFFICE_ACCESS_AUD='APPLICATION_AUDIENCE_FROM_CLOUDFLARE'
npm.cmd start
```

6. Bật tunnel từ cửa sổ Điện thoại trên PC. LioOps chỉ công bố trạng thái đã kết nối sau khi helper ghi nhận một kết nối tunnel. Bật quyền giao việc/phê duyệt theo nhu cầu.
7. Từ thiết bị khác, đăng nhập Access, nhập PIN Office rồi kiểm tra các chức năng theo hướng dẫn HTTPS. Thử cả tài khoản không được phép và cookie/JWT hết hạn trước khi nghiệm thu.

Cần khai báo đủ bốn biến managed. Thiếu/sai cấu hình sẽ báo lỗi, không tự mở Quick Tunnel thay thế. Đổi origin, chính sách Access, protocol hoặc sửa file token yêu cầu tắt/bật tunnel hay restart Office; helper không được dùng lại nếu cấu hình đã thay đổi. Tắt công tắc chỉ dừng helper do Office quản lý, không xóa tunnel/DNS/ứng dụng Access trong tài khoản Cloudflare.

## Ranh giới xác thực

Mọi request tới listener từ xa, kể cả PIN, health và asset, phải có `Cf-Access-Jwt-Assertion` hợp lệ. Server dùng `jose` đã ghim phiên bản để kiểm tra chữ ký RS256, issuer, audience, thời hạn và thời điểm phát hành; khóa công khai chỉ lấy từ `/cdn-cgi/access/certs` của team domain đã cấu hình. JWT giả, thiếu/hết hạn hoặc không lấy được khóa đều bị từ chối. Không dùng việc có header/cookie làm bằng chứng đã đăng nhập. Listener chủ máy vẫn hoạt động để sửa cấu hình hoặc tắt tunnel nếu Access lỗi.

Các bài unit và E2E dùng khóa RSA thực với issuer giả lập trong tiến trình test, kiểm tra chữ ký và toàn bộ listener/PIN qua restart. Chúng chưa xác nhận DNS, chính sách Access và tài khoản Cloudflare thật của người dùng.

Tài liệu chính thức: [managed tunnel và token file](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file), [xác minh JWT Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [ứng dụng web riêng](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/).
