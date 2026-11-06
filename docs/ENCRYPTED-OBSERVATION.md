# Mốc C — Connector quan sát có mã hóa

Ngày: 04/11/2026. Đây là triển khai nội bộ để kiểm chứng một luồng ghép thật qua relay và văn phòng cũ. Chưa phải bộ cài, dịch vụ online đã triển khai hoặc bản phát hành bảo mật đã được đánh giá độc lập.

Cập nhật 05/11/2026: tài liệu này mô tả đường C/protocol 1, vẫn chạy với `--log`. [Mốc D/protocol 2](OBSERVATION-D.md) mở rộng sang các dự án được cấp quyền và bổ sung đọc hội thoại theo ID, quota trong log, CPU/RAM theo quyền riêng. Các giới hạn chỉ hỗ trợ một log/không quota bên dưới thuộc C; không phải giới hạn của D.

## Phạm vi

Một Connector, một tab trình duyệt đang hoạt động, một file log JSONL được chọn rõ tại PC. Connector đọc định dạng Codex/Claude qua parser hiện có, lấy nội dung hiển thị, hoạt động và ngữ cảnh/token khi log có số liệu. Không dò lịch sử provider, đọc credential, chạy model, sửa dự án hoặc mở quyền giao việc. Chỉ đọc tối đa 4 MiB head/tail mỗi lần; C gửi 20 tin gần nhất, tối đa 1.000 ký tự/tin và 20 hoạt động với nhãn 200 ký tự để bản mã nằm trong giới hạn cả với Unicode. Đây là trích đoạn, không phải lịch sử đầy đủ hoặc quota tài khoản.

Connector không import `server/index.mjs`, Next hoặc Three. Website dùng `OfficeClient` với adapter `encrypted-relay`; dữ liệu public được chuyển thành snapshot cho renderer sau giải mã. `log.read` chỉ đọc cache trong RAM của adapter; không chuyển tiếp API cũ qua relay. Mọi operation khác, kể cả rewrite, ảnh, chat và quản trị, đều không có implementation remote ở C.

## Ghép và xác thực

1. Người vận hành cấu hình địa chỉ web và relay thử. Connector chọn đúng file tại PC, tạo hai cặp khóa P-256 riêng cho ký và nhận bản mã.
2. Trang đồng ý chỉ nghe loopback, có Host/Origin check và bearer ngẫu nhiên riêng mỗi lần khởi động. Bearer nằm ở fragment và được xóa khỏi thanh địa chỉ; không dùng cookie/PIN hay CORS LAN.
3. Connector tạo lời mời hết hạn sau 5 phút. Fragment chứa khóa public của Connector, capability ghép 256 bit và credential định tuyến; không chứa private key, đường dẫn log, prompt hoặc token đăng nhập AI. Website xóa fragment trước khi gửi request và chỉ liên hệ relay sau khi người dùng bấm **Yêu cầu ghép**.
4. Browser tạo khóa private không cho export. Nó ký hello chứa khóa public, capability ghép và nonce phiên, rồi mã hóa cho Connector. Connector xác minh chữ ký và lời mời; chưa gửi nội dung ở trạng thái chờ.
5. Người dùng so sánh **toàn bộ mã 43 ký tự** của browser tại hai đầu và cho phép trên PC. Mã được dẫn xuất từ cả hai khóa public, không phải PIN để giải mã. Quyền chỉ quan sát được lưu trước khi gửi xác nhận.
6. Browser chỉ nhận xác nhận có chữ ký đúng Connector đã ghim từ lời mời và đúng nonce hiện tại. Project ID ngẫu nhiên được ghim từ xác nhận. Browser dựng văn phòng rồi gửi `ready` có ký/mã hóa; chỉ sau đó Connector mới đọc và gửi snapshot, tránh dữ liệu cũ trong lúc dựng cảnh 3D.

Mã PC xác nhận kèm epoch của đúng yêu cầu đang chờ. Một browser khác không thể ghi đè peer đã tin. Muốn ghép mới phải thu hồi tại PC và khởi động lại Connector nội bộ. Lời mời chưa được duyệt mà hết hạn được thay khóa/route khi khởi động lại. Bản này dùng tin thiết bị, chưa thêm đăng ký/email LioOps.

## Bảo vệ thông điệp

Dùng `jose` hiện có: JWS ES256 nằm trong JWE ECDH-ES/A256GCM, theo thứ tự ký rồi mã hóa. Không thêm thuật toán mật mã hoặc phụ thuộc crypto mới. Thuật toán và kiểu token được allow-list tại đầu nhận; không dùng khóa do relay cung cấp.

Payload có version, route, issuer, audience, nonce phiên, sequence, phiên bản quyền, loại thông điệp, iat/exp và jti. Hello/ack bắt đầu sequence 0; các snapshot tăng tuần tự. Đổi phiên tạo nonce ngẫu nhiên mới. Sai khóa/đích/route/quyền/loại/schema, bản mã bị sửa, hết hạn, nonce cũ và replay bị chặn; thiếu sequence yêu cầu handshake mới. Không đưa giao thức thực thi hoặc hàng đợi công việc vào luồng này. Không có trường đường dẫn dùng để định tuyến/thực thi; văn bản log đã cho phép vẫn có thể chứa tên file/lệnh như chính nội dung phiên đó.

Mỗi token hết hạn sau 60 giây, cho lệch đồng hồ tối đa 15 giây. Snapshot còn kiểm tra sampledAt; mất dữ liệu mới quá 30 giây sẽ bỏ quyền đọc/cache và xóa phiên/nội dung drawer đang hiển thị. Kết nối lại xác thực bằng khóa peer đã ghim và nonce mới; không tự quay về local API hoặc demo. Chỉ nhớ ID của drawer đang xem trong RAM theo đúng context nguồn; sau khi cùng máy xác thực lại và gửi dữ liệu mới thì mới mở lại drawer đó. Không giữ lại nội dung cũ hoặc phục hồi view sang context khác. Thu hồi được ghi tại PC trước khi đóng route. Một thông điệp đang trên mạng không thể bị rút lại, và relay độc hại có thể trì hoãn ngắt; giới hạn độ mới phía browser vẫn áp dụng.

Connector chỉ để một snapshot chờ nhận. Browser gửi `seen` có chữ ký và mã hóa, ràng buộc đúng epoch/sequence; receipt sai hoặc lặp không giải phóng bản tiếp theo. Snapshot chưa được xác nhận quá 45 giây sẽ yêu cầu handshake mới. Khoảng 30/45 giây được chọn sau khi ca HTTPS tạm đo được vòng poll/receipt vượt 15 giây; không nới hạn chữ ký, sampledAt hoặc kiểm tra thứ tự. Luồng này ngăn queue đầy khi browser dựng 3D hoặc mạng chậm; receipt không thể đổi quyền hoặc chạy lệnh. Reconnect browser dùng backoff có giới hạn, không gửi dồn khi mạng lỗi.

Lưu quyền/thu hồi đi qua một hàng ghi tuần tự để một approval đang lưu không thể ghi đè revocation mới hơn. Lỗi ghi đĩa sẽ dừng chia sẻ và báo lỗi, không báo thu hồi bền vững thành công; cần giải quyết lỗi lưu trước khi khởi động lại để tránh dùng quyền cũ còn trên đĩa. Bộ đọc giữ file identity đầy đủ bằng bigint dev/ino, kiểm tra realpath và handle trước đọc; file bị thay/symlink hoặc filesystem không có identity sẽ bị từ chối thay vì đọc file khác.

## Dữ liệu lưu ở đâu

| Nơi | Dữ liệu |
| --- | --- |
| PC | Log gốc; identity, file được cấp quyền và peer trong file bảo vệ DPAPI CurrentUser trên Windows. File được flush trước thay atomically. Không tạo bản sao lịch sử. |
| Browser | Khóa CryptoKey không export và thông tin ghép trong IndexedDB; nội dung giải mã chỉ ở RAM/DOM. Không ghi prompt, log hay tên dự án remote vào localStorage. Quên máy vô hiệu nguồn trong runtime và xếp việc xóa sau các lượt lưu đang chờ, để lịch sử/bfcache không khôi phục nguồn đã quên. |
| Relay | Route ngẫu nhiên, hash credential, IP/rate counter, thời hạn và hàng đợi bản mã trong RAM. Không có private key hoặc lịch sử nội dung trên đĩa. |
| Provider | C không gọi provider; đọc đúng log đã có tại PC. |

Relay có 32 route tối đa theo mặc định, mỗi chiều 4 thông điệp, 256 KiB/thông điệp, tổng queue 8 MiB. Queue hết hạn sau 30 giây và được quét định kỳ; route hết hạn sau 24 giờ. Poll có deadline, disconnect dọn waiter; giới hạn origin, số kết nối, request và tốc độ. Không ghi body/Authorization/invitation vào access log. Reverse proxy/hosting sau này phải giữ cùng nguyên tắc; metadata mạng vẫn nhìn thấy được và chưa có dịch vụ production để cam kết thời hạn của hạ tầng đó.

**Giới hạn bảo mật:** JOSE không tự biến ứng dụng thành một giao thức đã được audit. Bản này không cung cấp forward secrecy khi private key lâu dài bị lộ. Mã JS từ hosting có quyền dùng khóa giải mã; CryptoKey không export không ngăn script cùng origin độc hại đọc nội dung đã giải mã. Cần đánh giá độc lập, CSP/chuỗi phát hành, vận hành relay và phục hồi khóa trước phát hành công khai. Xóa ghép ở browser không thu hồi credential tại PC; dùng nút thu hồi trên PC khi cần vô hiệu quyền đã cấp.

Trên POSIX, cơ chế lưu thử là file `0600`, không gọi nó là DPAPI hoặc mã hóa hệ điều hành. Bộ cài chính thức vẫn nhắm Windows trước.

## Chạy thử nội bộ

Các lệnh sau dành cho người phát triển mốc C, không phải trải nghiệm cài đặt của người dùng cuối. Dùng log thử hoặc file mà chủ PC đã chọn cho quan sát. Không dùng thư mục dữ liệu thật cho kiểm thử tự động.

Trên máy chạy relay (PowerShell):

```powershell
$env:LIOOPS_RELAY_ADMIN_TOKEN = '<secret ngẫu nhiên 256 bit, base64url 43 ký tự>'
$env:LIOOPS_WEB_ORIGINS = 'http://127.0.0.1:4311'
npm.cmd run relay:dev
```

Trên PC chạy Connector, tại terminal riêng:

```powershell
$env:LIOOPS_RELAY_URL = 'http://127.0.0.1:4320'
$env:LIOOPS_WEB_URL = 'http://127.0.0.1:4311/vi/'
$env:LIOOPS_RELAY_ADMIN_TOKEN = '<cùng secret của relay thử>'
$env:LIOOPS_CONNECTOR_DATA = '<thư mục riêng cho lượt thử>'
npm.cmd run connector:dev -- --log '<đường dẫn tuyệt đối tới session.jsonl đã chọn>'
```

Tạo secret bằng `node --input-type=module -e "import { randomSecret } from './src/shared/remote/crypto.js'; console.log(randomSecret())"`. Không đưa secret hoặc URL consent vào log hỗ trợ công khai.

Website cần build riêng bằng `npm.cmd run build:web`, rồi `npm.cmd run preview:web`. Connector in URL trang đồng ý loopback. Mở nó, mở lời mời ghép, yêu cầu ghép trên web, đối chiếu mã và xác nhận tại PC. Giữ PC bật để nhận cập nhật. Bộ cài/khay/tự chạy nền thuộc F; các lệnh này không cài startup, không sửa đăng nhập Codex/Claude hoặc khởi động lại app local cũ.

**Admin token ở trên chỉ dành cho relay thử do người vận hành kiểm soát. Không phân phối admin token toàn cục trong bộ cài cho người dùng.** Cơ chế cấp route dùng cho dịch vụ public, chống lạm dụng và triển khai HTTPS thật còn phải nghiệm thu. HTTP chỉ được phép với loopback; các origin khác cần HTTPS. Không xem thử hai cổng trên cùng máy là đã kiểm tra hai PC/mạng 4G.

## Bằng chứng và cổng còn lại

Unit có ca chữ ký/mã hóa, sai khóa, sửa nội dung, expiry, invitation, auth/origin/queue, identity file, bảo vệ credential, ghép/thu hồi, replay, đổi epoch/sequence/scope và ghi approval/thu hồi đồng thời. Browser test chạy web export, relay, Connector và trang PC thật với log fixture định dạng Codex trong dữ liệu riêng. Nó kiểm tra ghép, nội dung 3D, ngữ cảnh, append log, reload, mất mạng, reconnect, thu hồi và không gọi API PC.

Kết quả cuối và log được chốt ở `test-results-release-checks/c-summary.json`. Các ca loopback không phải phép đo hiệu năng hoặc bằng chứng truy cập Internet. Ca HTTPS riêng được mô tả bên dưới. Chưa nghiệm thu log do chủ PC chọn từ phiên người dùng thật qua mạng ngoài, cách ly hai PC, ký số/bộ cài, quota/số liệu máy hoặc giao việc remote. Các phần đó không được tính là hoàn thành nhờ build/unit/E2E fixture.

Ca `npm.cmd run test:observe:https -- --run` dùng một Quick Tunnel riêng cho relay, dữ liệu giả và web preview loopback. Nó đã chạy qua HTTPS bên ngoài máy với xác minh TLS bình thường, không tắt kiểm tra chứng chỉ; tunnel được đóng sau test. Ca này chứng minh đường relay Internet cho fixture, không chứng minh website đã deploy, hai PC cách ly hoặc provider/account thật. Lần nghiệm thu HTTPS thành công kiểm tra transport hoàn chỉnh; hardening thao tác quên máy sau đó còn được kiểm tra bằng unit và public-web suite ở bản cuối.

Tài liệu chuẩn: [jose](https://github.com/panva/jose), [JWE RFC 7516](https://www.rfc-editor.org/rfc/rfc7516), [thứ tự ký/mã hóa RFC 7519 §11.2](https://www.rfc-editor.org/rfc/rfc7519#section-11.2), [JWT BCP RFC 8725](https://www.rfc-editor.org/rfc/rfc8725).
