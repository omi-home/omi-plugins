# Runbook vận hành OMI

Dành cho người vận hành (PO, maintainer) một repo dùng plugin `omi-engineering`. Mọi lệnh là `omi <lệnh>`: trong repo này là `node bin/omi`, khi đã cài plugin thì Coordinator gọi qua skill. Thêm `--output json` để có kết quả máy đọc được. Mã thoát: `0` ok, `1` check fail hoặc lỗi, `2` sai cú pháp, `75` lỗi tạm thời (chạy lại). Chi tiết hành vi từng lệnh: `omi help`; phạm vi và quyết định: Issue trên [Project #2](https://github.com/orgs/omi-home/projects/2) và [ADR](../decisions/).

## 1. Đưa một repo vào OMI

Skill `/omi-engineering:omi-start`, hoặc tay theo thứ tự:

1. `omi doctor` — Node, git, gh, Claude Code, AGENTS.md, config, quyền GitHub. Thiếu `.omi/config.yaml` là bình thường trước bước 2.
2. `omi github project init [--title <text>]` — tìm/tạo Project, link repo, ghi `.omi/config.yaml`, cài Issue Forms + PR template vào `.github/` (không ghi đè file có sẵn).
3. `omi github repo plan --output json > plan.json` → PO duyệt → `omi github repo apply --approved-plan plan.json` (label, bảo vệ `main`/`develop`, merge method; chỉ thêm và siết, không bao giờ xoá hay nới).
4. `omi github project apply` — field, option, view. Exit 1 nghĩa là còn bước tay (filter/grouping/sort của view, built-in workflow, Insights): làm trên UI theo danh sách in ra.
5. `omi github repo validate`, `omi github project validate`.
6. Commit các file bước 2 qua một task bình thường (Issue → branch → PR → `develop`), rồi khai báo lệnh gate trong `checks`.

## 2. Cấu hình `.omi/config.yaml`

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
| `git.worktreeRoot` | `../.omi-worktrees` | Worktree: `<root>/<repo>/<issue>/` |
| `git.mergeMethod` | `squash` | Phải được repo cho phép |
| `review.maxAttempts` | `3` | Lần thử kỹ thuật mỗi bước (lỗi tạm thời không tính là round) |
| `review.maxValidationFixes` / `maxQaReworks` | `2` / `2` | Số lần sửa sau check/QA fail |
| `review.maxRounds` | `4` (cố định) | 2 round → Architect → 2 round → Waiting PO |
| `agents.maxConcurrent` | `3` | 1–3 |
| `agents.routing.<role>` | sonnet/medium; opus cho Architect, Code/Security Reviewer | `{ model, effort }` |
| `checks.<lint\|build\|test…>` | không có | Không khai báo = không có gate xác định |
| `cleanup.deleteRemoteBranch` | `false` | Xoá branch remote không bao giờ mặc định |
| `cleanup.logRetentionDays` | `14` | Evidence cục bộ |

Policy mặc định của plugin: `config/github/*.yaml` (hierarchy, field/view, status, governance) và `config/risk-policy.yaml`.

## 3. Quyền GitHub

- `gh auth login`, token có scope `repo` và `project` (thêm scope: `gh auth refresh -s project`). `omi doctor` báo `github-project` FAIL khi thiếu scope `project`.
- Quyền repo `write` trở lên (branch, comment, PR). `admin` chỉ cần cho `github repo apply`; doctor/`pr validate` cảnh báo token admin vì nó có thể vượt bảo vệ branch.
- Project: quyền write trên Project để đổi Status, admin để `project apply` tạo field/view.
- Marketplace từ máy không có SSH key GitHub: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`, và `gh auth setup-git`.

## 4. Giới hạn GitHub Free (ADR-0001 D5)

- Repo **private** trên Free không có branch protection/ruleset phía server: không có gì chặn push thẳng `main`/`develop` ngoài kỷ luật và kiểm tra của OMI. Ưu tiên repo public; nếu buộc private, PO ghi quyết định rồi đặt `github.privateRepoRiskAccepted: true` (doctor hết cảnh báo, rủi ro vẫn còn).
- `omi pr validate` báo `review: no review required by GitHub`: duyệt dựa vào review của OMI, không phải GitHub.
- CI chạy trên code agent push: đó không phải kiểm soát độc lập.
- Insights chart của Project không tạo được bằng API: làm tay.

## 5. Vòng đời một task

| Bước | Lệnh | Status Project |
|---|---|---|
| Kiểm ticket | `omi ticket validate <n>` | — |
| Bắt đầu | `omi task start <n>` (branch + worktree riêng) | In Progress (cha Backlog/Ready → In Progress) |
| Chạy agent | `omi task run <n>` (Feature/CR/FR/NFR: `omi task analyze <n>`) | In Progress / Rework / In QA |
| Mở PR | `omi pr create <n>` → `develop`, `Closes #<n>` | In Review |
| Merge | `omi pr validate <n>`, `omi pr merge <n>` (risk:high: PO merge) | — |
| Hoàn tất | `omi task finalize <n>` từ checkout chính sau `git pull` | Done + roll-up cha |

Finding hoãn sang task khác: comment `<!-- omi:carried-findings=<ID> -->` trên Issue đích; `omi issue findings <n>` liệt kê khi bắt đầu. Tổng quan: `omi status`. Cuối phiên: `omi handoff post --body-file <f>`; đầu phiên: `omi handoff show` (skill `omi-resume`).

## 6. Escalation và khôi phục

| Tình huống | Dấu hiệu | Xử lý |
|---|---|---|
| Agent/check báo BLOCKED | Status Blocked, report BLOCKED trên Issue | Người quyết định, rồi `omi task unblock <n> --reason <text>` và `omi task run <n>` |
| Hết 4 round review hoặc Architect báo đổi phạm vi | Status Waiting PO, comment escalation | PO quyết định; worktree được giữ. Không có lệnh resume: PO tạo work item mới (Change Request / DevTask) hoặc đóng Issue. Không chạy round thứ 5 |
| PR đã merge nhưng cleanup lỗi | `task finalize` exit 1, run CLEANUP_FAILED, Status Blocked | Đọc report cleanup trên Issue; sửa nguyên nhân (worktree bẩn: commit hoặc chuyển thay đổi đi; file đang bị khoá; path lạ) rồi chạy lại `omi task finalize <n>`. Không `--force` |
| Phiên crash giữa chừng | `omi cleanup scan` thấy attempt mở, report chưa đăng, task đã merge chưa dọn | `omi cleanup apply --safe` |
| Report không đăng được | outbox pending; bước không tiến | Lỗi tạm thời: chạy lại lệnh; lỗi quyền: sửa token rồi chạy lại |
| Hai phiên cùng một Issue | `LOCK_HELD` (exit 75) | Đợi phiên kia, không xoá lease |

## 7. Rate limit và lỗi tạm thời

`GITHUB_RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `NETWORK`, `LOCK_HELD` thoát mã `75`: không đổi state, chạy lại lệnh sau. `omi doctor` cảnh báo khi còn < 10% quota (kèm giờ reset); xem nhanh: `gh api rate_limit`. Lỗi tạm thời là attempt mới, không tính là round review. `GITHUB_AUTH` (401/403/thiếu scope) không tự hết: sửa token.

## 8. Xoá an toàn

- OMI chỉ xoá thứ nó sở hữu và đã xác minh (worktree sạch, branch đã merge theo receipt của GitHub), không bao giờ `--force`, không xoá branch remote (trừ `cleanup.deleteRemoteBranch: true`).
- Worktree mồ côi (`cleanup scan` báo `orphan`) không bị xoá tự động. Người kiểm tra nội dung trước, rồi `git worktree remove <path>` (không `--force`) và `git branch -d <branch>`.
- State cục bộ ở `<git-common-dir>/omi/state.sqlite` (dùng chung mọi worktree, không commit). Không xoá khi còn run mở; xoá là mất lịch sử run và outbox chưa đăng.

## 9. Release

Skill `/omi-engineering:omi-release`:

1. Một DevTask đặt cùng version semver mới vào `.claude-plugin/plugin.json` và `package.json`, đổi `## [Unreleased]` trong `CHANGELOG.md` thành `## [<version>] - <ngày>`; merge vào `develop`.
2. Release Issue (`omi issue create --type release --parent <Milestone> …`), rồi `omi release check <n>` tới khi mọi dòng PASS.
3. `omi pr create <n>` mở PR `develop → main`; **PO merge**.
4. `omi release tag <n>`: tag `omi-engineering--v<version>` trên merge commit, push, đóng Release Issue.

Người dùng cài/update/rollback theo tag: [README](../../README.md#cài-plugin). Trước khi update, sao lưu `state.sqlite`: migration chỉ đi tiến và bản cũ từ chối DB mới hơn; rollback qua một migration thì khôi phục bản sao lưu.
