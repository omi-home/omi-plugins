# ADR-0007 — Profile thực thi ở DB cấp máy (sửa ADR-0004 D3)

- **Trạng thái:** Accepted. PO duyệt 2026-11-22 (Feature-0044 #337; phạm vi PO 2026-11-21: chỉ profile, sau Feature-0043 #321). Sửa vị trí lưu và quy tắc migration của [ADR-0004](./ADR-0004-omi-monitor-hai-repo-profile-va-token-ma-hoa.md) D3.
- **Ngày:** 2026-11-22
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Nguồn:** [Feature-0044 #337](https://github.com/omi-home/omi-plugins/issues/337), section `architecture` (Decision record). Triển khai: DevTask-0118 #357 (docs), các DevTask kế tiếp của #337.

## Bối cảnh

ADR-0004 D3 đặt profile (kèm token mã hóa) trong bảng `profile` của `<workspace>/.omi-plugins/state.sqlite`. Mỗi workspace mới phải `omi profile import` hoặc `set-token` lại, dù master key (biến env User `OMI_SECRET_KEY`) đã là cấp máy. PO muốn khai báo profile một lần cho mọi project trên máy. Không đổi: CLI contract, contract `Profile`, monitor protocol; run/step/outbox vẫn ở `state.sqlite` của workspace.

## Quyết định

| # | Chủ đề | Quyết định |
| --- | --- | --- |
| D1 | Vị trí | `profiles.sqlite` trong thư mục cấu hình người dùng theo OS: win32 `%LOCALAPPDATA%\omi`, darwin `~/Library/Application Support/omi` (đường dẫn được định nghĩa, macOS vẫn không hỗ trợ theo ADR-0004), còn lại `${XDG_CONFIG_HOME:-~/.config}/omi`. Biến `OMI_PROFILE_DB` (đường dẫn tuyệt đối tới file; tương đối → `CONFIG_INVALID`) ghi đè. Bên đọc không tạo file; bên ghi (`add`, `set-token`, `import`) tạo. Không có DB cấp máy nghĩa là chưa có profile, step dùng `agents.routing`. |
| D2 | Quan hệ với `state.sqlite` | Profile (cùng token mã hóa) chỉ nằm ở DB cấp máy. Run/step/outbox ở lại từng workspace. Migration 9 của state đổi tên bảng `profile` thành `profile_legacy` và thêm cột `migrated_at TEXT`; bảng này chỉ `omi profile import` đọc, chỉ import ghi (đánh dấu đã chuyển), không bao giờ tự xóa. |
| D3 | Cả hai nơi có profile | Còn dòng `profile_legacy` có `migrated_at IS NULL` thì mọi thao tác đọc/ghi profile (`loadProfiles`, resolver, `omi profile *`, `secret *`) dừng `CONFIG_INVALID` và hướng dẫn chạy `omi profile import`; không âm thầm chọn một bên (cùng quy tắc với guard file cũ của ADR-0004 D3). Import tính kế hoạch theo từng tên so với DB cấp máy: chưa có → chép nguyên dòng, gồm cột sealed, không giải mã (AAD là tên nên ciphertext vẫn hợp lệ); cùng tên, cùng field và token bằng nhau → `identical`, chỉ đánh dấu đã chuyển; cùng field, máy chưa có token mà nguồn có → chép cột sealed (`tokenFilled`); còn lại là xung đột (liệt kê tên field khác và token `differs`/`unverifiable`). Xung đột chỉ giải bằng `--resolve <name>=machine\|workspace` (lặp được). Còn xung đột chưa giải → `CONFIG_CONFLICT` với `details.conflicts[{name, fields[], token}]` (không có giá trị) và không ghi gì. `--dry-run` trả kế hoạch. Thực thi: một tx trên DB cấp máy, rồi một tx trên DB workspace đặt `migrated_at`, rồi bước `.bak` file cũ. Sập giữa hai tx thì chạy lại ra `identical`: idempotent. |
| D4 | Quyền file | POSIX: thư mục `0700`, file `profiles.sqlite`, `-wal`, `-shm` `0600`; `omi doctor` kiểm. Windows: dựa vào ACL của thư mục user profile `%LOCALAPPDATA%`, không kiểm. |
| D5 | Khóa ghi | WAL, `busy_timeout` 5000 ms, `synchronous=FULL`, giao dịch ghi ngắn `BEGIN IMMEDIATE`, mỗi thao tác mở một kết nối rồi đóng ngay. Hết timeout → `LOCK_HELD` (tạm thời, thử lại được). Không đặt DB trên network share. |
| D6 | Master key | Không đổi (ADR-0004 D4): biến env User tên lấy từ `secrets.keyEnv`, mặc định `OMI_SECRET_KEY`. Mọi workspace trên máy phải cho cùng một key; lệch hiện `SECRET_KEY_MISMATCH` và doctor báo lỗi. `secret init-key` kiểm `hasAnySealedSecret` trên DB cấp máy; `secret rotate-key` mã hóa lại DB cấp máy trong một tx và kết quả nói rõ mọi workspace trên máy bị ảnh hưởng. |

## Hệ quả

- Workspace mới không cần thao tác profile nào. Workspace đang dùng chạy `omi profile import` **một lần** (kèm `--resolve` nếu trùng tên khác nội dung).
- ADR-0004 D3 giữ hình dạng bảng, tên profile bất biến và CLI; chỉ vị trí lưu và quy tắc migration bị thay bằng ADR này. D1, D2, D4, D5 của ADR-0004 giữ nguyên.
- Rotate key một workspace đổi key cho cả máy: các workspace khác phải cập nhật biến env cùng lúc.
- Sao lưu profile là sao lưu `profiles.sqlite` (cùng `-wal`), không còn nằm trong `state.sqlite`.
- Ngoài phạm vi: đồng bộ profile giữa nhiều máy, chuyển run/step/outbox lên cấp máy, đổi thuật toán mã hóa hay nơi giữ master key.
