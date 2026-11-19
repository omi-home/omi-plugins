# Runbook vận hành OMI

Dành cho người vận hành (PO, maintainer) một repo dùng plugin `omi-coordinator`. Mọi lệnh là `omi <lệnh>`: trong repo này là `node bin/omi`, khi đã cài plugin thì Coordinator gọi qua skill. Thêm `--output json` để có kết quả máy đọc được. Mã thoát: `0` ok, `1` check fail hoặc lỗi, `2` sai cú pháp, `75` lỗi tạm thời (chạy lại). Chi tiết hành vi từng lệnh: `omi help`; phạm vi và quyết định: Issue trên [Project #2](https://github.com/orgs/omi-home/projects/2) và [ADR](../decisions/).

## 1. Đưa một repo vào OMI

Skill `/omi-coordinator:omi-start`, hoặc tay theo thứ tự:

0. `omi workspace init [--name <n>] [--repo <path|url>]` — dựng `<name>-workspace/` (`.claude/`, `.omi-plugins/`, `AGENTS.md` của Coordinator) và clone repo vào đó; chạy các bước sau trong workspace. Chạy lại an toàn.
   Repo đang dùng layout cũ (`.omi/config.yaml`, task worktree): theo [runbook chuyển đổi](./workspace-migration.md) (`omi workspace migrate`, gỡ file cũ qua task PR, kiểm bằng `omi doctor`, cách quay lại).
1. `omi doctor` — Node, git, gh, Claude Code, AGENTS.md, config, quyền GitHub. `omi.config.yaml` chưa có section `github` là bình thường trước bước 2.
2. `omi github project init [--title <text>]` — tìm/tạo Project, link repo, ghi section `github` vào `.omi-plugins/omi.config.yaml`, cài Issue Forms + PR template vào `.github/` (không ghi đè file có sẵn).
3. `omi github repo plan --output json > plan.json` → PO duyệt → `omi github repo apply --approved-plan plan.json` (label, bảo vệ `main`/`develop`, merge method; chỉ thêm và siết, không bao giờ xoá hay nới).
4. `omi github project apply` — field, option, view. Exit 1 nghĩa là còn bước tay (filter/grouping/sort của view, built-in workflow, Insights): làm trên UI theo danh sách in ra.
5. `omi github repo validate`, `omi github project validate`.
6. Commit các file bước 2 qua một task bình thường (Issue → branch → PR → `develop`), rồi khai báo lệnh gate trong `checks`.

## 2. Cấu hình `.omi-plugins/omi.config.yaml`

Schema strict (field lạ bị từ chối): [runtime/core/config.ts](../../runtime/core/config.ts). Tối thiểu:

```yaml
github: { owner: <org>, repo: <repo>, projectNumber: <n> }
checks:
  lint: { run: npm run lint }
  build: { run: npm run typecheck }
  test: { run: npm test }
```

| Khoá | Mặc định | Ghi chú |
|---|---|---|
| `github.privateRepoRiskAccepted` | `false` | Chỉ bật khi PO chấp nhận repo private không có bảo vệ phía server (mục 4) |
| `git.baseBranch` / `git.releaseBranch` | `develop` / `main` | Task PR → base; release PR base → release |
| `git.mergeMethod` | `squash` | Phải được repo cho phép |
| `review.maxAttempts` | `3` | Lần thử kỹ thuật mỗi bước (lỗi tạm thời không tính là round) |
| `review.maxValidationFixes` / `maxQaReworks` | `2` / `2` | Số lần sửa sau check/QA fail |
| `review.maxRounds` | `4` (cố định) | 2 round → Architect → 2 round → Waiting PO |
| `agents.maxConcurrent` | `3` | Dự phòng: runtime hiện chạy agent tuần tự, chưa đọc khoá này |
| `agents.routing.<role>` | sonnet/medium; opus cho Architect, Code/Security Reviewer | `{ model, effort }` |
| `checks.<format\|lint\|build\|test\|scan>` | không có | `{ run, timeoutSec }` (timeout mặc định 600 s); tên khác bị từ chối. Không khai báo = không có gate xác định |
| `cleanup.deleteRemoteBranch` | `false` | Dự phòng: cleanup hiện không xoá branch remote dù đặt `true` |
| `cleanup.logRetentionDays` | `14` | Evidence cục bộ |

Policy mặc định của plugin: `config/github/*.yaml` (hierarchy, field/view, status, governance) và `config/risk-policy.yaml`.

## 3. Quyền GitHub và xác thực agent

- `gh auth login`, token có scope `repo` và `project` (thêm scope: `gh auth refresh -s project`). Thiếu scope `project`: `omi doctor` báo `github-auth` FAIL (INSUFFICIENT_SCOPES); `github-project` FAIL nghĩa là Project không tồn tại, không truy cập được hoặc đã đóng.
- Quyền repo `write` trở lên (branch, comment, PR). `admin` chỉ cần cho `github repo apply`; `pr validate`/`pr merge` cảnh báo token admin vì nó có thể vượt bảo vệ branch (doctor chỉ in quyền `admin`, không cảnh báo).
- Project: quyền write trên Project để đổi Status, admin để `project apply` tạo field/view.
- Marketplace từ máy không có SSH key GitHub: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`, và `gh auth setup-git`.
- Agent (`task run`, `task analyze`) chạy với `CLAUDE_CONFIG_DIR` riêng và env dựng từ allowlist, nên không thấy login của host, `ANTHROPIC_API_KEY` hay token GitHub. Cần đặt `CLAUDE_CODE_OAUTH_TOKEN` (lấy bằng `claude setup-token`) trong env của lệnh `omi`; thiếu biến này thì bước agent dừng `CONFIG_INVALID`, run sang BLOCKED. Profile thực thi (Feature-0021 #137) sẽ cấp token theo profile.

## 4. Giới hạn GitHub Free (ADR-0001 D5)

- Repo **private** trên Free không có branch protection/ruleset phía server: không có gì chặn push thẳng `main`/`develop` ngoài kỷ luật và kiểm tra của OMI. Ưu tiên repo public; nếu buộc private, PO ghi quyết định rồi đặt `github.privateRepoRiskAccepted: true` (doctor hết cảnh báo, rủi ro vẫn còn).
- `omi pr validate` báo `review: no review required by GitHub`: duyệt dựa vào review của OMI, không phải GitHub.
- CI chạy trên code agent push: đó không phải kiểm soát độc lập.
- Insights chart của Project không tạo được bằng API: làm tay.

## 5. Vòng đời một task

| Bước | Lệnh | Status Project |
|---|---|---|
| Kiểm ticket | `omi ticket validate <n>` | — |
| Bắt đầu | `omi task start <n>` (task workspace: clone + branch riêng) | In Progress (cha Backlog/Ready → In Progress) |
| Chạy agent | `omi task run <n>` (Feature/CR/FR/NFR: `omi task analyze <n>`) | Trong lúc chạy: In Progress / Rework / In QA; dừng ở In Review (PR_PENDING), Waiting PO hoặc Blocked |
| Mở PR | `omi pr create <n>` → `develop`, `Closes #<n>` | In Review (đặt lại nếu đã ở đó) |
| Merge | `omi pr validate <n>`, `omi pr merge <n>` | Giữ In Review; `risk:high` → Waiting PO, không merge, PO merge tay |
| Hoàn tất | `omi task finalize <n>` từ checkout chính sau `git pull` | Done + roll-up cha |

Finding hoãn sang task khác: comment `<!-- omi:carried-findings=<ID> -->` trên Issue đích; `omi issue findings <n>` liệt kê khi bắt đầu. Tổng quan: `omi status`. Cuối phiên: `omi handoff post --body-file <f>`; đầu phiên: `omi handoff show` (skill `omi-resume`).

## 6. Escalation và khôi phục

| Tình huống | Dấu hiệu | Xử lý |
|---|---|---|
| Agent/check báo BLOCKED, hoặc hết `maxAttempts` lỗi tạm thời | Status Blocked, `omi task status <n>` = BLOCKED, report BLOCKED trên Issue | Người quyết định, rồi `omi task unblock <n> --reason <text>` và `omi task run <n>` |
| Hết 4 round review hoặc Architect báo đổi phạm vi | Status Waiting PO, comment escalation | PO quyết định; task workspace được giữ. Không có lệnh resume: PO tạo work item mới (Change Request / DevTask) hoặc đóng Issue. Không chạy round thứ 5 |
| PR đã merge nhưng cleanup lỗi | `task finalize` exit 1, run CLEANUP_FAILED, Status Blocked | Đọc report cleanup trên Issue; sửa nguyên nhân (clone bẩn hoặc chưa push: commit/push hoặc chuyển thay đổi đi; file lạ trong task workspace; file đang bị khoá; path lạ) rồi chạy lại `omi task finalize <n>`. Không `--force` |
| Phiên crash giữa chừng | `omi cleanup scan` thấy attempt mở, report chưa đăng, task đã merge chưa dọn | `omi cleanup apply --safe` |
| Report không đăng được | outbox pending; bước không tiến | Lỗi tạm thời: chạy lại lệnh; lỗi quyền: sửa token rồi chạy lại |
| Status Blocked nhưng `task status` là RECOVERY_REQUIRED hoặc FAILED | `task unblock` báo INVALID_TRANSITION | CLI hiện không tự đưa run vào hai state này; không sửa DB tay, báo maintainer kèm `omi task status <n> --output json` |
| Hai phiên cùng một Issue | `LOCK_HELD` (exit 75) | Đợi phiên kia, không xoá lease |

## 7. Rate limit và lỗi tạm thời

Lỗi tạm thời (`GITHUB_RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `NETWORK`, `LOCK_HELD`, `REPORT_NOT_POSTED`, `CRASH_RECOVERED`) thoát mã `75`: chạy lại lệnh sau. Trong `task run`, mỗi lỗi tạm thời là một attempt mới của cùng bước; hết `review.maxAttempts` thì run sang BLOCKED. `omi doctor` cảnh báo khi còn < 10% quota (kèm giờ reset); xem nhanh: `gh api rate_limit`. Attempt không tính là round review. `GITHUB_AUTH` (401/403/thiếu scope) không tự hết: sửa token.

## 8. Xoá an toàn

- OMI chỉ xoá thứ nó sở hữu và đã xác minh (task workspace sạch, chỉ chứa file OMI sinh ra, tip của clone khớp receipt merge của GitHub), không bao giờ `--force`, không xoá branch remote.
- Task workspace mồ côi (`cleanup scan` báo `orphan`: `<workspace>-task-*` không thuộc run nào đang mở) không bị xoá tự động. Người kiểm tra nội dung (commit chưa push?) rồi tự xoá thư mục.
- State cục bộ ở `<workspace>/.omi-plugins/state.sqlite` (dùng chung mọi task workspace, ngoài repo). Không xoá khi còn run mở; xoá là mất lịch sử run và outbox chưa đăng.

## 9. Release

Skill `/omi-coordinator:omi-release`:

1. Một DevTask đặt cùng version semver mới vào `.claude-plugin/plugin.json` và `package.json`, đổi `## [Unreleased]` trong `CHANGELOG.md` thành `## [<version>] - <ngày>`; merge vào `develop`.
2. Release Issue (`omi issue create --type release --parent <Milestone> …`), rồi `omi release check <n>` tới khi mọi dòng PASS.
3. `omi pr create <n>` mở PR `develop → main`; **PO merge**.
4. `omi release tag <n>`: tag `<plugin>--v<version>` (`omi-coordinator--v…`) trên merge commit, push, đóng Release Issue.

Người dùng cài/update/rollback theo tag: [README](../../README.md#cài-plugin). Trước khi update, sao lưu `state.sqlite`: migration chỉ đi tiến và bản cũ từ chối DB mới hơn; rollback qua một migration thì khôi phục bản sao lưu.
