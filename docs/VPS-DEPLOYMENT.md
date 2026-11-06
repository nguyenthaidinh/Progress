# LioOps triển khai web và relay trên VPS

Đích triển khai: `https://ops.liotnu.com`, source tại `https://github.com/nguyenthaidinh/Progress`.

VPS chạy bản export web công khai và relay chuyển bản mã. Không chạy server Office cá nhân, không đăng nhập Codex/Claude và không chứa dự án hoặc lịch sử AI của người dùng. Bản hiện tại hỗ trợ quan sát C/D; bộ cài và giao việc qua Connector thuộc kế hoạch E/F/G.

## Bố trí trên VPS

- `/srv/lioops/releases/<commit>` chứa source/build của từng bản.
- `/srv/lioops/current` là symlink tới bản đang phục vụ.
- `/opt/lioops/node` là runtime Node 22 riêng; không thay Node hoặc container của dịch vụ khác.
- `/etc/lioops/relay.env` chứa cấu hình và credential relay, chỉ root/nhóm service đọc; không commit hoặc chép vào web export.
- Relay chạy bằng user `lioops`, systemd unit `deploy/vps/lioops-relay.service`, chỉ nghe `127.0.0.1:14320`.
- Nginx riêng cho hostname phục vụ `current/web-site`, proxy `/v1/` tới relay và cung cấp `/healthz`, `/relay-health`.
- Cấu hình chỉ tin địa chỉ client do Nginx loopback ghi đè. Cloudflare real-IP được giới hạn bằng danh sách mạng từ nguồn chính thức, trong vhost LioOps.

## Build và chuyển bản

Lấy đúng commit, cài dependency từ lockfile và build bằng user không đặc quyền:

```sh
npm ci --no-audit --no-fund
OFFICE_SITE_URL=https://ops.liotnu.com OFFICE_BUILD_WORKERS=1 NEXT_TELEMETRY_DISABLED=1 npm run build:web
```

Sinh vhost bằng `deploy/vps/nginx.py` từ chính HTML đã build. CSP dùng hash inline script của export thay vì cho phép inline script tùy ý. Dùng `--asset-root` trỏ build mới và `--web-root /srv/lioops/current/web-site` làm đường phục vụ ổn định. TLS dùng chứng chỉ đúng hostname; challenge HTTP nằm ở `/var/www/lioops-acme`.

Trước chuyển bản: giữ lại symlink/config cũ, kiểm tra source/build và `nginx -t`. Đổi `current` nguyên tử, cập nhật service, kiểm tra health rồi reload Nginx. Không restart hoặc thay cấu hình ứng dụng khác. Rollback phải phục hồi cả symlink lẫn vhost cũ vì CSP gắn với HTML của từng bản.

Relay là mailbox trong RAM: restart sẽ mất queue/route tạm. Connector đã ghép sẽ xác thực/đăng ký lại theo cơ chế reconnect; không có dữ liệu AI để migrate ở VPS.

## Kiểm tra sau deploy

1. `/vi/`, trang tiếng Anh, asset và HTTPS hợp lệ.
2. `/healthz` và `/relay-health` trả trạng thái khỏe.
3. `/api/tasks`, `/.env`, `/.git/HEAD` không được công khai.
4. Web chưa ghép không gọi API PC; demo chỉ chạy khi được chọn.
5. `scripts/deploy-web-smoke.mjs` kiểm tra trình duyệt/CSP bằng profile mới.
6. `scripts/deploy-relay-smoke.mjs` kiểm tra ghép, log giả, đổi quyền và thu hồi qua HTTPS thật. Credential operator lấy từ môi trường riêng, không in vào báo cáo. Không gọi model thật.

Admin token hiện dùng cho provisioning nội bộ, không được nhúng vào browser hoặc phát cho bộ cài public. Enrollment người dùng cuối chưa được triển khai. Nút tải bộ cài vẫn tắt cho đến khi có artifact đã nghiệm thu. Chạy website trên VPS không tự kết nối tới Codex của khách truy cập.

## Git và CI

Source loại `data`, credential, thư mục máy, dependency và build qua manifest/Git ignore. Giữ giấy phép và attribution của upstream. CI chạy unit/lint/type/build, các ca local đã chốt và public web; đây không phải toàn bộ suite visual cũ. Workflow demo GitHub Pages chỉ chạy thủ công vì đích hosting là VPS.

Vận hành cập nhật chỉ dùng release đã kiểm tra. Không đưa mật khẩu SSH, key, token, log AI hoặc support bundle chưa được duyệt vào repo, command line hay artifact public.
