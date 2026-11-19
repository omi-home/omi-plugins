# Runbook chuyển sang layout workspace

Dành cho repo đang dùng layout cũ: `.omi/config.yaml` trong repo, state trong `.git/omi/state.sqlite`, task worktree ở `../.omi-worktrees/`. Layout mới theo [ADR-0002](../decisions/ADR-0002-workspace-va-profile-thuc-thi-claude-code.md), hợp đồng thư mục ở [overview](../architecture/overview.md#workspace-và-task-workspace). Từ DevTask-0053 #166, CLI không còn đọc `.omi/`, nên phải chuyển trước khi chạy lệnh OMI nào khác ngoài `doctor` và `workspace migrate`.

## 1. Chuẩn bị

1. Đóng hết run đang mở: PR đã merge thì `omi task finalize <n>`; task chưa xong thì làm xong hoặc dừng hẳn. `omi doctor` báo `legacy-runs` khi còn run mở trong state cũ.
2. Dọn hết task worktree (`git worktree list` chỉ còn checkout chính). Migrate từ chối chạy khi còn run mở hoặc worktree.
3. Sao lưu `.git/omi/state.sqlite`. Migrate chỉ đọc file này, bản sao lưu là để chắc chắn.

## 2. Chuyển

Chạy trong checkout chính của repo:

```bash
omi workspace migrate --dry-run   # in các bước sẽ làm và các file cũ cần gỡ
omi workspace migrate             # [--name <n>]: mặc định tên repo
```

Migrate làm các việc sau:
- Dựng `<name>-workspace/` cạnh repo (giống `omi workspace init`) và clone repo vào `<name>-workspace/<repo>/`.
- Copy `.omi/config.yaml` sang `.omi-plugins/omi.config.yaml`.
- Copy state sang `.omi-plugins/state.sqlite` (`VACUUM INTO`, file cũ không bị đụng).

Chạy lại an toàn: cái gì đã có thì giữ nguyên. Migrate không xoá gì trong repo.

Từ đây làm việc trong `<name>-workspace/`: mở Claude Code ở thư mục workspace, chạy `omi` trong `<name>-workspace/<repo>/`. Checkout cũ chỉ còn là bản dự phòng.

## 3. Gỡ file cũ khỏi repo

Migrate in danh sách `remove` gồm những gì đang có trong `.omi/`, `AGENTS.md`, `.claude/`, `CLAUDE.md`. Gỡ chúng bằng một task bình thường:

1. Tạo Issue (DevOpsTask/DevTask), rồi `omi task start <n>` từ `<name>-workspace/<repo>/`.
2. Trong task workspace: `git rm -r` các mục cần gỡ. Nội dung chỉ dẫn dự án cần giữ thì chuyển vào `AGENTS.md` của workspace (Coordinator) trước khi gỡ.
3. `omi pr create <n>` → merge → `omi task finalize <n>`.

## 4. Kiểm tra

```bash
omi doctor
```

Cần PASS ở các dòng:
- `layout`: repo không còn `.omi/`, `AGENTS.md`, `.claude/`.
- `profiles-file`: `omi.config.json` nằm ngoài repo.
- `legacy-runs`: không còn run mở trong state cũ.
- `config`: đọc được `.omi-plugins/omi.config.yaml`.

Sau đó chạy thử `omi status` và `omi task start <n>` cho task kế tiếp. Task workspace phải nằm ở `<name>-workspace-task-<run>/<repo>/`.

Agent (`omi task run`/`task analyze`) cần biến `CLAUDE_CODE_OAUTH_TOKEN` (lấy bằng `claude setup-token`): agent chạy với `CLAUDE_CONFIG_DIR` riêng, không dùng login của host ([runbook vận hành, mục 3](./operations.md#3-quyền-github-và-xác-thực-agent)).

## 5. Quay lại nếu lỗi

| Lỗi ở bước | Cách quay lại |
|---|---|
| 2: migrate dừng giữa chừng hoặc kết quả sai | Repo và state cũ còn nguyên. Kiểm `<name>-workspace/<repo>/` không có commit chưa push, xoá thư mục `<name>-workspace/`, sửa nguyên nhân rồi chạy lại migrate |
| 3: PR gỡ file cũ đã merge nhưng cần lấy lại nội dung | Revert PR đó bằng một task mới; nội dung vẫn còn trong lịch sử git |
| Bản OMI mới không dùng được | Cài lại plugin theo tag cũ ([README — Rollback](../../README.md#cài-plugin)), làm việc tiếp trong checkout cũ với `.omi/` và state cũ (chưa bị sửa). Run tạo sau khi migrate chỉ có trong state mới, không chuyển ngược được |
