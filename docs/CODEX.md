# Codex trong LioOps

Muốn soạn prompt trên web và gửi về PC từ mạng khác: xem [hướng dẫn truy cập từ xa](REMOTE-CODEX.md). Bản này có nút Giao việc trực tiếp, biên nhận chống chạy trùng và vòng đời tunnel Windows; việc xác nhận qua HTTPS/4G thật được ghi riêng trong hướng dẫn.

LioOps hỗ trợ Claude Code và Codex trong cùng văn phòng. Mỗi phiên Codex có logo riêng; dữ liệu phiên được gửi qua SSE hiện có, nên dùng chung nhân vật, danh sách phiên, activity feed và ngăn hội thoại.

## Khởi động

Repo ghim Codex CLI **0.166.0** trong dependency chính thức `@openai/codex`. Sau `npm ci`, văn phòng ưu tiên bản CLI này để tránh chọn nhầm CLI cũ từ app desktop hoặc PATH. Đăng nhập bằng `node node_modules/@openai/codex/bin/codex.js login` nếu máy chưa có đăng nhập Codex. LioOps dùng tài khoản và cấu hình của Codex CLI; không đọc hay sao chép token vào cấu hình Claude.

Trên Windows PowerShell, tại thư mục repo:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Mở <http://localhost:4310>. Với môi trường phát triển dùng `npm.cmd run dev`.

`OFFICE_CODEX_BIN` là override rõ ràng; nếu không đặt, server ưu tiên bản ghim trong repo rồi mới tìm CLI hệ thống. Override không hợp lệ sẽ báo không tìm thấy CLI, không lặng lẽ đổi sang bản khác. Có thể chỉ định executable hoặc JavaScript entry point:

```powershell
$env:OFFICE_CODEX_BIN = 'C:\path\to\codex.exe'
npm.cmd start
```

Tắt tích hợp bằng `OFFICE_CODEX=0`. Codex App Server do văn phòng khởi chạy dùng stdio cục bộ, không mở cổng mạng riêng. Tình trạng kết nối có trong `/api/doctor` và `/api/tasks`.

## Theo dõi phiên có sẵn

- Mỗi 5 giây, server đọc tối đa 30 hội thoại mới cập nhật qua App Server. Phiên cập nhật trong 30 phút gần nhất được đưa vào văn phòng; phiên agent con không chiếm thêm bàn.
- Đây là đọc lịch sử, không resume hay điều khiển phiên của IDE/terminal. Trạng thái chạy suy ra từ dữ liệu đã lưu có thể trễ; lượt `inProgress` cũ hơn 10 phút không được mặc định coi là vẫn chạy.
- Ngăn hội thoại đọc những lượt gần nhất; activity feed chỉ thêm hoạt động mới, không phát lại toàn bộ lịch sử khi server khởi động. Số thao tác hiển thị phản ánh những mục đã được đọc trong lần chạy hiện tại.
- Nội dung public được che các mẫu secret trước khi đưa vào giao diện. Nội dung suy luận nội bộ không được chuyển thành tin nhắn của văn phòng.

## Giao việc và phê duyệt

Mở **Giao việc AI** trên thanh trên cùng (điện thoại có thêm mục **AI** ở thanh dưới). Chọn **Codex** hoặc **Claude Code**, chọn dự án, viết prompt rồi bấm **Gửi cho AI**. `Ctrl+Enter` gửi prompt; Enter xuống dòng. Các tùy chọn model, mức suy luận và bắt đầu từ phiên đang mở nằm trong **Tùy chọn hội thoại**.

Đây là màn hình riêng với nhóm **Công ty**. Bên trái là lịch sử các hội thoại AI; bên phải là yêu cầu, tiến trình, câu trả lời và thẻ duyệt lệnh của cuộc đang chọn. Chọn một cuộc trò chuyện để nhắn tiếp đúng phiên đó. Khi AI đang làm, nút gửi chuyển thành **Gửi bổ sung**; ảnh được gửi khi lượt hiện tại kết thúc. Có thể dừng hoặc mở hội thoại Codex trên PC tại đầu màn hình.

Trong bảng chi tiết của một phiên, nút **Giao việc AI** mở lại hội thoại tương ứng nếu đã có. Nội dung đang soạn được giữ trong tab hiện tại khi đổi hội thoại hoặc đóng rồi mở lại. Mục **Việc bỏ quên → Giao AI làm nốt** điền sẵn thư mục và yêu cầu để bạn xem lại, chọn trợ lý rồi gửi. Chỉ mở màn hình này chưa khởi chạy tác vụ. Dòng trạng thái hội thoại hiển thị phần trăm ngữ cảnh còn lại của Codex hoặc bộ nhớ đệm Claude khi phiên có dữ liệu.

Lịch sử mới được lưu riêng ở `data/workspace.json`, gồm prompt và kết quả đã che chuỗi nhạy cảm, số ảnh đính kèm (không lưu ảnh gốc trong file này), ID hội thoại và tiến trình. Giới hạn 30 hội thoại và 20 lượt gần nhất mỗi hội thoại; khi đủ chỗ chỉ loại lịch sử đã kết thúc, giữ các cuộc đang chạy. Sau khi server khởi động lại, lượt chưa xác nhận xong được đánh dấu **Cần kiểm tra**, không tự chạy lại. Tin nhắn nhóm công ty và lịch sử cũ vẫn được giữ; các API giao việc cũ vẫn tương thích.

Codex do LioOps khởi chạy hoạt động nền qua App Server cục bộ. Mặc định, sau khi giao việc, LioOps gửi yêu cầu mở đúng hội thoại trong ứng dụng Codex trên máy tính bằng [deep link chính thức](https://learn.chatgpt.com/docs/app/commands#deep-links). Nó mở hội thoại của công việc, không chèn prompt vào cuộc trò chuyện khác đang mở. Bạn vẫn theo dõi tiến trình và duyệt lệnh trong LioOps.

Trên mỗi thẻ công việc Codex có nút **Mở trong Codex trên PC**, dùng cả từ máy tính và điện thoại. Nút luôn nhắm tới PC chạy LioOps; không mở Codex trên thiết bị đang duyệt web và không gửi lại prompt. Hội thoại phải do LioOps tạo trên PC đó. Từ xa cần đăng nhập và được bật quyền giao việc; việc đổi tùy chọn tự mở chỉ thực hiện được từ PC.

Muốn tắt tự mở, vào bảng **Giao việc** trên PC, chọn Codex và bỏ chọn **Tự mở hội thoại trong Codex trên máy tính khi giao việc**. Lựa chọn được lưu qua lần khởi động lại. Nút mở thủ công vẫn dùng được. Nếu chưa cài ứng dụng Codex hoặc mở ứng dụng thất bại, tác vụ vẫn được giữ và theo dõi trong LioOps. Trên Windows và macOS cần ứng dụng đăng ký giao thức `codex://`; trên Linux cần trình xử lý giao thức qua `xdg-open`. Đặt `OFFICE_CODEX_DESKTOP=0` để tắt mọi thao tác mở ứng dụng, chẳng hạn khi chạy kiểm thử tự động.

Trong ô prompt, nhấn **Ctrl+V** (macOS: **⌘V**) để dán ảnh từ clipboard, hoặc chọn nút **Ảnh**. Ảnh có bản xem trước và nút xóa; tối đa 4 ảnh mỗi việc. Có thể chỉ gửi ảnh để nhờ AI xem, hoặc viết prompt kèm ảnh. Gửi việc sẽ chờ ảnh chuẩn bị xong; dán văn bản thông thường vẫn hoạt động như trước.

Trợ lý soạn prompt hiện ngay trong màn hình AI: gợi ý thêm tiêu chí, nói rõ phần đang chỉ tới hoặc đánh số nhiều việc. Những gợi ý này xử lý tại trình duyệt. Chỉ nút **Viết lại cho rõ · dùng chút lượt Claude** mới gọi Claude để viết lại; có thể hoàn tác. Đóng hoặc đổi hội thoại trong lúc viết lại sẽ không chép câu trả lời sang bản nháp khác.

Khi gửi việc tới phiên bên ngoài, văn phòng tạo một **fork**. Những lần gửi tiếp từ cùng đích sẽ tiếp tục bản fork do văn phòng tạo. Ánh xạ hội thoại và thư mục được lưu nguyên tử trong `data/codex-threads.json`, nên khởi động lại server vẫn nhận diện được bản fork. File này không chứa prompt, token đăng nhập hay yêu cầu phê duyệt. Phiên gốc vẫn do IDE/terminal quản lý. Phiên do văn phòng quản lý dùng sandbox `workspace-write`, chính sách `on-request` và phê duyệt bởi người dùng.

Trước khi resume, server đối chiếu ID/thư mục và trạng thái lượt gần nhất. Nếu lượt trước vẫn được đánh dấu đang chạy hoặc chưa xác nhận kết thúc, yêu cầu mới bị từ chối; văn phòng không tự gửi lại lượt có thể đã được Codex nhận.

Các yêu cầu duyệt lệnh, thay đổi file và câu hỏi lựa chọn hiện trong giao diện phê duyệt sẵn có. Câu hỏi được đánh dấu bí mật dùng ô nhập mật khẩu. Phê duyệt chỉ cho phép một lần hoặc từ chối; không tự thêm luật “luôn cho phép”. Nút Từ chối dùng `decline` nếu được hỗ trợ; nếu Codex chỉ cung cấp `cancel`, lượt bị ngắt theo protocol. Sự kiện và yêu cầu phê duyệt của lượt cũ không được thay đổi tác vụ đang chạy. Loại tương tác chưa hỗ trợ nhận lỗi từ chối qua protocol.

Nút dừng trên thẻ công việc dùng `thread/backgroundTerminals/list` và `thread/backgroundTerminals/terminate` để kết thúc terminal gắn với các lệnh của lượt hiện tại, rồi gọi `turn/interrupt`. Adapter kiểm tra lại terminal sau khi ngắt để xử lý lệnh có thể vừa khởi chạy. Các terminal từ lượt trước và thread khác được giữ nguyên; ID terminal chỉ được gửi qua protocol, không được dùng làm PID hệ điều hành.

Thẻ hiển thị **Đang dừng Codex** đến khi nhận trạng thái kết thúc và hoàn tất kiểm tra terminal. Nếu không xác nhận được việc dừng lệnh, công việc báo lỗi thay vì báo đã dừng thành công. Một phản hồi xác nhận đã nhận lệnh dừng không được coi là tác vụ đã dừng. Nếu thiếu sự kiện hoàn thành, vòng đọc lịch sử sẽ đối chiếu lượt và lấy lại kết quả cuối. Điều khiển này áp dụng cho terminal do Codex quản lý; không bảo đảm dừng tiến trình do một MCP server bên ngoài tự tạo.

Nút chen lời trên thẻ gửi `turn/steer` kèm ID lượt đang chạy. Chỉ tác vụ do văn phòng quản lý mới nhận được tin này; không tiếp quản phiên của ứng dụng bên ngoài.

## Model và hạn mức

Bảng Giao việc cho phép chọn model từ catalog Codex và mức suy luận được model đó công bố hỗ trợ. Mặc định vẫn dùng cấu hình Codex. Catalog không bảo đảm tài khoản có quyền gọi mọi model; lỗi quyền truy cập từ Codex vẫn được báo khi bắt đầu lượt.

Thanh trên có nút **Codex · còn …%**. Bấm để xem hạn mức còn lại của từng cửa sổ thời gian và thời điểm đặt lại. Số gọn trên nút lấy cửa sổ chặt nhất của bucket Codex; popup liệt kê cả các bucket khác nếu có. Bảng Giao việc cũng hiển thị phần trăm còn lại.

Hạn mức lấy từ `account/rateLimits/read` và sự kiện cập nhật. Đây là ảnh chụp dữ liệu có thời điểm cập nhật; server làm mới khoảng hai phút một lần, giao diện kiểm tra bản chụp mỗi 30 giây và khi mở popup. Khi thiếu dữ liệu, giao diện hiện dấu gạch/chưa có số liệu, không tự suy ra còn 100%. Quota Codex tách riêng khỏi quota Claude; chưa ước tính chi phí USD cho Codex.

Mỗi phiên Codex có **Context còn …%** trong danh sách và ngăn chi tiết, kèm số token đã dùng / dung lượng context, tổng token vào/ra và thời điểm cập nhật. Context còn lại được tính từ số token của lần gọi gần nhất và `modelContextWindow` Codex công bố; tổng token tích lũy được hiển thị riêng, không dùng để tính phần trăm context. Sau khi compact, phần trăm còn lại có thể tăng.

Phiên do văn phòng tạo nhận `thread/tokenUsage/updated`. Phiên ngoài và phiên sau restart đọc snapshot `token_count` đã lưu trong rollout JSONL của Codex, mỗi vòng kiểm tra khoảng 5 giây. Bộ đọc chỉ chấp nhận file đúng ID phiên trong `CODEX_HOME/sessions` hoặc `archived_sessions`, đọc tối đa 1 MiB cuối file, bỏ qua bản ghi dở và chỉ giữ các trường số token. Không resume phiên để lấy token. File chưa có số liệu, lịch sử định dạng khác hoặc thiếu dung lượng context sẽ hiện chưa có dữ liệu; không đoán dung lượng theo tên model.

Quyền giao việc và phê duyệt từ điện thoại tiếp tục tuân theo các công tắc hiện có; lệnh được đánh dấu rủi ro chỉ có thể được cho phép trên máy cục bộ. Chỉ dự án đã được văn phòng nhận diện mới được giao việc; API không nhận một đường dẫn tùy ý từ điện thoại.

## Giới hạn hiện tại

- Phiên theo dõi từ bên ngoài không có nút điều khiển tiến trình hay chuyển tài khoản Claude.
- Số token phiên ngoài cập nhật sau khi Codex ghi lịch sử cục bộ; lịch sử nén hoặc định dạng chưa hỗ trợ có thể chưa có số liệu.
- Chưa có đăng nhập nhiều tài khoản Codex hay tự động chuyển tài khoản.
- Khởi động lại server giữ thông tin nối lại hội thoại nhưng không tự phát lại hay khôi phục tác vụ model đang chạy dở. Khi mất kết nối, tác vụ được báo lỗi; không giả định công việc chưa xảy ra.
- App Server và một số phương thức phân trang còn thay đổi theo phiên bản CLI. Lỗi kết nối được hiển thị trong bảng Giao việc; server thử lại sau 30 giây.

## Mức sẵn sàng

Bản này ở mức **beta đã có kiểm thử chức năng**, chưa được đánh giá là production hay tương đương mọi chức năng Claude. Có kiểm thử cho restart, nối lại đúng dự án, dừng chờ xác nhận, chen lời đúng lượt, thiếu sự kiện hoàn thành, timeout, UTF-8 bị chia chunk, gói tin quá lớn và dữ liệu từ tiến trình đã mất kết nối. Chưa có kiểm thử chạy dài nhiều ngày hay xác nhận đầy đủ trên macOS/Linux.

## Kiểm thử

```powershell
node --test tests/unit/codex.test.mjs
node node_modules/@playwright/test/cli.js test tests/e2e/codex.spec.ts
```

Integration test dùng App Server giả lập và dữ liệu tạm riêng; không chạy model, không thực thi lệnh Codex, không đọc lịch sử Codex thật. Kiểm tra kết nối thực tế đọc danh sách phiên, model và quota.

Ngày 02/11/2026 đã chạy một lượt smoke test thật qua CLI ghim 0.166.0, model cấu hình của máy `gpt-6.1-sol`, hội thoại ephemeral và sandbox chỉ đọc. Kết quả: `completed`, trả đúng chuỗi cố định yêu cầu, không gọi công cụ. CLI desktop 0.142.0 trước đó trả lỗi model không được hỗ trợ với cùng tài khoản. Bản CLI ghim giúp tái lập môi trường mà không nâng cấp hay sửa app Codex toàn cục.

Tài liệu protocol chính thức: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

### Chạy kiểm thử với Codex thật

```powershell
npm.cmd run test:codex:live -- --run
```

Đây là kiểm thử chủ động dùng đăng nhập CLI hiện có và tiêu thụ quota model; không chạy trong bộ unit/E2E mặc định. Bỏ `--run` chỉ in hướng dẫn. Có thể thêm `--scenario=repair`, `--scenario=approvals` hoặc `--scenario=controls` để chạy một nhóm.

Runner tạo dự án Node dùng thư viện có sẵn trong `test-results-codex-live/run-*`, không sửa mã sản phẩm hay cài dependency. File mẫu và `report.json` được giữ để đối chiếu, tách khỏi thư mục Playwright sẽ xóa khi chạy E2E. Các hội thoại kiểm thử được lưu trong lịch sử Codex cục bộ để kiểm tra resume qua restart và được archive khi kết thúc nếu không còn tác vụ chạy; runner không đọc token đăng nhập.

Các kịch bản đối chiếu kết quả thực:

- Sửa lỗi tính số lượng, chạy test trước/sau; bộ test phải giữ nguyên nội dung.
- Thêm tính năng giảm giá bằng yêu cầu tiếp theo trong cùng hội thoại.
- Khởi động lại adapter, giữ nguyên thread ID và nhớ mã hội thoại chưa ghi ra file.
- Cho phép lệnh tạo marker một lần; từ chối lệnh khác và xác nhận marker không tồn tại. Runner chỉ tự cho phép lệnh fixture đã chỉ định.
- Chen lời khi lệnh đang chạy và kiểm tra model thực hiện chỉ dẫn mới.
- Dừng lệnh đang chạy, chờ trạng thái `interrupted`, rồi đợi qua thời điểm lệnh dự kiến ghi file để xác nhận lệnh thực sự đã kết thúc.
- Ngắt tiến trình App Server do runner tạo, xác nhận tác vụ báo lỗi, kết nối mới đọc được metadata và không tự gửi lại `turn/start`.

Đây là kiểm thử adapter với model và công cụ thật. Bộ Playwright riêng kiểm tra luồng giao diện/API bằng App Server giả lập; không coi đó là một phiên model thật chạy xuyên qua trình duyệt.

Ngày 02/11/2026, cả **8/8 kịch bản live** trên Windows đã đạt với CLI 0.166.0 và model cấu hình `gpt-6.1-sol`. Lần chạy này phát hiện và giúp sửa lỗi Từ chối khi danh sách lựa chọn chỉ có `accept`/`cancel`. Kiểm thử unit bổ sung bao phủ cả lựa chọn này và sự kiện đến muộn từ lượt trước. Kết quả này chưa thay thế kiểm thử chạy dài hoặc xác nhận trên macOS/Linux.

### Kiểm thử xuyên suốt giao diện với Codex thật

```powershell
npm.cmd run build
npm.cmd run test:codex:ui:live -- --run
```

Runner dùng Chromium của Playwright, server LioOps thật trên một cổng localhost trống và Codex CLI ghim trong repo. Không giả lập model hay API. Cần đăng nhập CLI và cài Chromium trước (`npx.cmd playwright install chromium` nếu máy chưa có). Lượt chạy dùng quota Codex; bỏ `--run` chỉ in hướng dẫn. Thêm `--headed` để xem trình duyệt.

Có thể thêm `--scenario=stop` để chỉ kiểm tra nút Dừng; trong chế độ này runner tự chuẩn bị mã mẫu đã đúng để không cần gọi model sửa lỗi trước.

Thêm `--scenario=usage` để chỉ kiểm tra hiển thị token/context và hạn mức trên dữ liệu Codex thật. Chế độ này cần ít nhất một phiên gần đây có snapshot token; không bắt đầu lượt model, không thay đổi hay archive phiên đang được theo dõi.

Dự án mẫu, dữ liệu Office riêng, báo cáo và ảnh chụp nằm trong `test-results-codex-live/ui-*`. Server quan sát lịch sử Codex hiện có như ứng dụng bình thường, nhưng runner chỉ giao việc, phê duyệt, dừng và archive các tác vụ mẫu do chính nó tạo. Runner không đọc token đăng nhập và không lưu log khởi động có URL truy cập. Ảnh chụp chỉ lấy thẻ phê duyệt, thẻ công việc hoặc kết quả trong chat.

Các thao tác gửi việc, Cho phép, Từ chối và Dừng đều đi qua nút trên giao diện. API được đọc để đối chiếu trạng thái; mã mẫu được kiểm tra bằng `node --test` độc lập và bộ test phải giữ nguyên nội dung. Có bốn kịch bản:

- Gửi việc từ bảng Giao việc, duyệt lệnh tạo marker đúng một lần, sửa lỗi, kiểm tra Markdown và lịch sử kết quả.
- Gửi yêu cầu bổ sung tới cùng hội thoại và kiểm tra tính năng giảm giá bằng test mới.
- Từ chối lệnh, xác nhận thẻ chuyển sang đã dừng và marker không được tạo.
- Bấm Dừng khi lệnh thật đang chạy, chờ trạng thái kết thúc và xác nhận lệnh không ghi file sau thời gian dự kiến.

Ngày 02/11/2026, cả **4/4 kịch bản giao diện thật** đã đạt trên Windows với CLI 0.166.0. Vòng này phát hiện trường hợp `turn/interrupt` báo đã ngắt nhưng tiến trình con vẫn ghi file sau đó. Adapter đã bổ sung kết thúc terminal theo từng lệnh của lượt hiện tại trước khi ngắt, kiểm tra lại sau khi ngắt và chờ hoàn tất kiểm tra trước khi kết thúc thẻ công việc. Kịch bản Dừng riêng cũng đã đạt; test unit bao phủ việc giữ nguyên terminal từ lượt trước, chờ kiểm tra terminal, báo lỗi khi không xác nhận được và lệnh vừa tự kết thúc trong lúc dừng.
