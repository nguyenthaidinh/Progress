# D — Quan sát dự án qua Connector

Ngày: 05/11/2026. Mốc D mở rộng quan sát trên giao diện văn phòng cũ; chưa phải bộ cài hoặc dịch vụ public đã phát hành. Kết quả nghiệm thu và giới hạn được chốt tại `test-results-release-checks/d-summary.json`. Mốc C dùng `--log`/protocol 1 tiếp tục được hỗ trợ; D dùng `--project`/protocol 2 và kho ghép riêng.

Mỗi Connector vẫn ghép một browser và phục vụ một tab đang hoạt động. Kiểm tra hai Connector cách ly không đồng nghĩa đã có giao diện chuyển giữa nhiều PC trong cùng browser.

## Hành vi

- PC chọn tối đa 16 thư mục dự án không chồng nhau. Connector tìm JSONL Codex/Claude trong các nguồn log được cấp quyền, kiểm tra `cwd` thực tế thuộc dự án rồi mới đọc phần hội thoại. Browser chỉ dùng ID ngẫu nhiên/HMAC; không gửi đường dẫn để mở file tùy ý.
- Web nhận danh sách phiên, provider, hoạt động, token/ngữ cảnh khi log có số liệu. Chỉ hội thoại được chọn mới được yêu cầu qua thông điệp mã hóa `read {op: log, id, requestId}`. Không thêm shell, API proxy hoặc thao tác thực thi.
- Quyền nội dung hội thoại, quota trong log và tổng CPU/RAM là ba lựa chọn riêng tại trang PC. CPU/RAM mặc định tắt. Tắt nội dung vẫn giữ metadata phiên; nội dung drawer và request đang chờ bị xóa.
- Thay quyền cần đúng revision hiện tại, được lưu bền vững trước khi xác thực lại. Epoch cũ vô hiệu ngay ở Connector; browser chỉ nhận revision tăng từ peer đã ghim. Không đổi danh sách dự án qua web. Muốn đổi phạm vi, thu hồi rồi tạo lượt ghép mới tại PC.
- Trạng thái làm việc từ log là ước lượng. Phiên quá hai phút không có dữ liệu được ghi là chưa rõ; không gộp vào nghỉ. Dữ liệu thiếu không trở thành 0% hoặc 100%.
- Context và quota tài khoản khác nhau. Quota chỉ đọc các cửa sổ `rate_limits` có số liệu hợp lệ trong log Codex, hiển thị riêng từng phiên cùng thời điểm nguồn. Quá năm phút hoặc qua giờ reset thì hiện số liệu cũ. Chưa có nguồn quota Claude thì hiện chưa có dữ liệu; không đọc credential hoặc gọi provider để lấy quota.
- Số liệu máy là tổng CPU/RAM hệ điều hành, không có danh sách tiến trình, hostname hay PID. CPU ở mẫu đầu, sau khoảng nghỉ dài hoặc counter reset là chưa có dữ liệu. Chỉ số Connector riêng ở trang PC phục vụ chẩn đoán local, không đi qua relay.

## Giới hạn và dữ liệu

Mỗi lượt phát tối đa 40 phiên, mỗi phiên có 3 hoạt động xem trước nếu có quyền. Hội thoại được chọn tối đa 20 tin/20 hoạt động, 1.000 ký tự/tin. Một file đọc tối đa 4 MiB head/tail; tail của log lớn phải có `cwd` xác nhận lại vì phần giữa bị bỏ có thể đã đổi dự án. Tail không có anchor không được chia sẻ. Đường dẫn root/project dùng realpath và dev/ino; thay thư mục hoặc junction làm phạm vi không hợp lệ và dọn catalog.

Mỗi chu kỳ tìm tối đa 512 entry, 128 thư mục chờ, 128 file trong catalog, 16 lượt parse và ngân sách đọc 8 MiB. Độ sâu tìm tối đa 6; cache theo identity/size/mtime và watcher chỉ là gợi ý có giới hạn. Khi chưa tìm xong hoặc chạm giới hạn, UI báo dữ liệu giới hạn/đang tìm thêm phiên. Không tuyên bố đây là lịch sử đầy đủ. Bộ giới hạn UTF-8 giữ payload trước JOSE dưới 125.000 byte và cắt trích đoạn cũ trước; bản mã phải dưới 256 KiB.

Giữ cơ chế `ready/seen` của C: một snapshot chờ ACK; browser chỉ có một lượt gửi đọc đang chạy và một lựa chọn mới nhất chờ gửi. Chọn phiên khác vô hiệu phản hồi cũ. Mất dữ liệu mới quá 30 giây dọn cache/DOM và quyền đọc; receipt quá 45 giây buộc handshake mới. Trở lại tab sau gián đoạn buộc bỏ dữ liệu cũ, xác thực epoch mới. Reconnect không tự chạy công việc hay quay về API PC.

Phản hồi hội thoại chưa đọc bằng `json()` cũng bị vô hiệu khi mất kết nối/đổi quyền; bật lại quyền không làm phản hồi cũ hợp lệ trở lại. Trang PC chỉ giữ một lượt cập nhật trạng thái đang chạy, có timeout và bỏ phản hồi bắt đầu trước thao tác cấp/thu hồi mới. Sau khi ghép, mất mạng không tự che văn phòng bằng cửa sổ cấu hình; người dùng có thể mở cấu hình từ thanh kết nối.

Log gốc ở PC. Cache parse và nội dung đã giải mã chỉ ở RAM. File `identity-d.json` dùng DPAPI CurrentUser trên Windows; browser lưu khóa không export và thông tin ghép trong IndexedDB, không lưu transcript. Relay giữ bản mã có giới hạn trong RAM. Các ranh giới bảo mật/hosting JavaScript, metadata mạng và việc chưa audit độc lập vẫn như [tài liệu C](ENCRYPTED-OBSERVATION.md). Không hứa bên thứ ba tuyệt đối không thể can thiệp.

## Thử nội bộ

Chuẩn bị relay, web và biến môi trường như [hướng dẫn C](ENCRYPTED-OBSERVATION.md#chạy-thử-nội-bộ), dùng thư mục dữ liệu riêng. Lệnh dưới đây dành cho người phát triển, chưa phải trải nghiệm người dùng cuối:

```powershell
npm.cmd run connector:dev -- --project 'F:\Projects\MyProject'
```

Có thể lặp `--project`. Mặc định nguồn Codex là `$CODEX_HOME/sessions` (hoặc `~/.codex/sessions`), nguồn Claude là `$CLAUDE_CONFIG_DIR/projects` (hoặc `~/.claude/projects`) nếu tồn tại. Để dùng hoàn toàn dữ liệu thử:

```powershell
npm.cmd run connector:dev -- --project 'F:\Fixtures\Project' --codex-logs 'F:\Fixtures\Codex' --claude-logs 'F:\Fixtures\Claude'
```

`--no-content`, `--no-quota` tắt quyền ban đầu; `--metrics` bật chia sẻ CPU/RAM. Quyền đã lưu được giữ khi khởi động lại cùng phạm vi; CLI không âm thầm cấp lại quyền đã tắt tại PC. Không dùng đồng thời `--log` và `--project`. Mã này không cài startup, thay đăng nhập AI, sửa dự án hoặc khởi động lại LioOps local.

## Bằng chứng và phần chưa nghiệm thu

Nghiệm thu mã nội bộ: 236 unit (233 đạt, 3 bỏ qua theo nền tảng), 7 ca web và 4 ca local chọn theo phạm vi đều đạt ở các lượt chốt. Lint không warning, typecheck, build local riêng và export EN/VI đạt. Các lỗi của ca ghép ở lượt đầu đã được sửa và chạy lại; không gọi kết quả này là toàn bộ E2E suite đạt. Tên ca, log và phạm vi từng lượt nằm trong báo cáo JSON.

Unit kiểm tra scope, cache, log lớn, header dài, đổi dự án trong log, Unicode qua JOSE, quyền/revision, đọc phiên có tương quan, hai Connector dùng chung relay, nguồn thiếu/cũ và metrics opt-in. Browser dùng web export, relay, trang consent và Connector thật với log giả riêng; hồi quy C/local chạy riêng. Các test không dùng tài khoản, lịch sử hoặc quota thật của người dùng.

`node scripts/observation-benchmark.mjs --seconds=30` chạy tiến trình Connector CLI riêng với 20 log giả khoảng 500 KB/file. Xem kết quả mẫu Windows/Node 22 tại `test-results-release-checks/d-benchmark.json`. RAM/CPU được lấy từ tiến trình Node của Connector sau khi đã tìm đủ 20 phiên; không cộng tiến trình PowerShell bảo vệ credential lúc cấu hình, provider hoặc browser 3D. Thời gian khởi động được đo riêng tới lúc trang PC sẵn sàng, trước khi ghép. Đây là phép đo ngắn, không phải ngân sách đảm bảo cho mọi máy.

Lượt đo cuối: khởi động khoảng 0,94 giây, RAM cao nhất trong các mẫu khoảng 71,7 MiB, CPU trung bình 2,31% của một lõi logic trong 30,5 giây. Bộ test trình duyệt tổng hợp từng ghi nhận bước lưu/khôi phục quyền chậm hàng chục giây khi máy có tải; chưa chốt cam kết độ trễ hoặc hiệu năng của bộ cài.

Chưa có kiểm tra hai PC vật lý/4G, ngủ-thức hệ điều hành thật, log thật do chủ máy chọn hoặc đo liên tục 8 giờ. Phân lập hai Connector trong test không thay cho các ca đó. Chưa có bộ cài, tự chạy nền, đăng ký route public, giao việc qua Connector (E), ký số/update/uninstall (F) hoặc nghiệm thu phát hành (G). LioOps vẫn là sản phẩm miễn phí; không có chức năng thanh toán được thêm.
