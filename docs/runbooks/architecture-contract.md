# Runbook: bật contract kiến trúc cho repo

Liên quan: Feature-0043 #321, DevTask-0106 #327, ADR-0006. Runbook đầy đủ cho repo đích do T4 bổ sung; file này nêu các bước tối thiểu để `omi doctor` hết cảnh báo.

## Các bước

1. Tạo `omi-architecture.yaml` ở gốc repo (hoặc đặt đường dẫn khác trong `omi.config.yaml`: `architecture.contract`, đường dẫn tương đối, không có `..`).
2. Khai báo `stack`, `sourceRoots`, `layers`, `modules` (kèm `dependsOn`) và `placement`.
3. Chạy `node bin/omi arch check --repo <repo>`. Mỗi vi phạm có file, quy tắc và cách sửa.
4. Vi phạm có sẵn chưa sửa kịp: ghi vào `legacy` kèm Issue và lý do. `omi doctor` cảnh báo (`warn`) khi `legacy` còn phần tử.
5. Gate `omi task run` tự chạy check `architecture` khi worktree có contract; không có contract thì `skipped`.

## Lỗi thường gặp

- `CONTRACT_INVALID`: contract sai schema hoặc là symlink ra ngoài repo.
- `ARCH_VIOLATION`: import vượt ranh giới, file sai chỗ hoặc module chưa khai báo; làm theo thông điệp sửa.
