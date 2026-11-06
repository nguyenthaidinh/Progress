# LioOps Quan sát không cài

LioOps giữ giao diện văn phòng cũ trên website online, kết nối tới Connector cài một lần và tự chạy nền trên PC. Bản web hiện mới có cấu hình ban đầu và các nguồn demo/đọc log; kết nối PC qua relay mã hóa cùng bộ cài chưa hoàn thành. Bản local cũ tiếp tục được hỗ trợ. Xem [kế hoạch hiện hành](PUBLIC-BETA-PLAN.md).

Trang Quan sát trong tài liệu này là công cụ phụ ở `/observe/`, không còn là trang chủ và không thay thế văn phòng. Nó đọc nhật ký trong trình duyệt khi người dùng chủ động chọn file/thư mục.

## Cách dùng

1. Khi cần công cụ phụ, mở `/observe/` trên bản local hoặc `/vi/observe/` trên bản web tiếng Việt. Cấu hình kết nối của giao diện chính nằm trong **Cài đặt → Cấu hình kết nối máy tính**.
2. Chọn **Chọn thư mục nhật ký**: Codex thường dùng `.codex/sessions`, Claude dùng `.claude/projects`. Trình duyệt chỉ được yêu cầu quyền đọc. Chrome/Edge desktop qua HTTPS hoặc localhost là phạm vi hỗ trợ đầu tiên.
3. Nếu trình duyệt không hỗ trợ quyền thư mục, dùng **Nhập file nhật ký** để chọn các file `.jsonl`. Đây là bản chụp; cần chọn lại file để cập nhật.
4. Xem các phiên, token và ngữ cảnh nếu có dữ liệu. Bấm **Văn phòng 3D** để mở cảnh với các phiên đã chọn; mặc định dùng danh sách để tiết kiệm tài nguyên. Đóng 3D sẽ hủy iframe và giải phóng cảnh.
5. Bấm **Ngắt và xóa dữ liệu đang xem** để dừng đọc, xóa dữ liệu trong Worker/giao diện và đóng 3D. Quyền thư mục bị thu hồi cũng dừng đọc và xóa màn hình hiện tại.

Nhật ký không được upload lên server LioOps. Trang không gọi API giao việc, không dùng thông tin đăng nhập AI và không tự chạy lệnh. Credential/configuration file bị loại trước khi đọc; nội dung suy luận không được đưa vào dữ liệu quan sát. Nội dung hiển thị đi qua bộ che mẫu bí mật dùng chung; đây không phải cam kết nhận diện được mọi bí mật trong văn bản.

## Đọc và cập nhật

- Đọc file trong Worker, tránh phân tích JSON trên luồng giao diện. Cache theo file/size/mtime; file không thay đổi không bị phân tích lại hoặc gửi toàn bộ dữ liệu sang giao diện.
- File đã nhận diện được kiểm tra khoảng 2,5 giây khi tab hiện. Danh mục được quét lại khoảng 15 giây để phát hiện file mới; trình duyệt có thể trì hoãn tab nền. Không coi đây là xác nhận tiến trình AI đang chạy.
- Mỗi lượt tối đa 10.000 mục thư mục, 128 file và 40 phiên gần đây; mỗi phiên giữ tối đa 40 tin nhắn và 40 thao tác. Khi đạt giới hạn có thông báo để chọn thư mục nhỏ hơn.
- File lớn chỉ đọc tối đa khoảng 4 MiB từ phần đầu/cuối. Khi quá số bản ghi, ưu tiên giữ metadata đầu và bản ghi cuối. Lịch sử hoặc tổng token Claude có thể thiếu, được đánh dấu rõ.
- File JSONL sai hoặc đang ghi dở không làm mất các bản ghi hợp lệ khác. Thông tin chỉ được tổng hợp theo phần nhật ký đã đọc.
- Token đầu vào/đầu ra, ngữ cảnh phiên và hạn mức tài khoản là các chỉ số khác nhau. Thiếu kích thước ngữ cảnh thì không đoán 200k/1M. Hạn mức tài khoản mới nhất, CPU/RAM hệ thống và giao việc cần thành phần Connector, chưa được cung cấp bởi trang này.
- Trạng thái hoạt động được ghi là ước lượng; nhật ký cũ có trạng thái hiện tại chưa xác định. Không biến số liệu thiếu thành 0% hoặc 100%.

## Build web để đưa lên hosting tĩnh

```powershell
npm.cmd run build:web
```

Kết quả ở `web-site/`: tiếng Anh tại `/`, tiếng Việt tại `/vi/`, cùng giao diện văn phòng cũ và bước cấu hình đầu tiên. `?demo` mở văn phòng mẫu được ghi rõ; không báo đó là dữ liệu đã kết nối. Upload nội dung thư mục này lên hosting hỗ trợ HTTPS. Không đưa `data/`, `.codex` hoặc `.claude` lên hosting.

Xem trước bản export trên PC:

```powershell
npm.cmd run preview:web
```

Mở `http://127.0.0.1:4311/vi/`. Server xem trước chỉ phục vụ file tĩnh trên loopback, không có API điều khiển PC. Có thể đặt `WEB_PORT` để đổi cổng. Dừng server xem trước bằng Ctrl+C.

`build:web` tách `web-site/` và `.web-build/` khỏi `.next` của app local. Bản build demo cũ vẫn giữ `demo-site/` và `.demo-build/`. Bản local tiếp tục dùng `npm.cmd run build` và `npm.cmd start` như trước.

## Phần đang tiếp tục phát triển

Connector, ghép máy, relay nhiều người, nguồn hạn mức có xác thực, bộ cài Windows đã ký và giao việc từ web public là các phần tiếp theo. Chúng không được xem là đã có chỉ vì trang Quan sát đã build được. Xem [kế hoạch phát hành miễn phí](PUBLIC-BETA-PLAN.md).
