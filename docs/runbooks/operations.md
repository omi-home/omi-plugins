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

Schema strict (field lạ bị từ chối): [runtime/shared/config.ts](../../runtime/shared/config.ts). Tối thiểu:

```yaml
github: { owner: <org>, repo: <repo>, projectNumber: <n> } # tuỳ chọn: model: legacy | v2 (mặc định legacy)
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
| `agents.routing.<role>` | sonnet/medium; opus cho Architect, Code/Security Reviewer | `{ model, effort }`. Nâng cấp từ 11 role: đổi khoá `frontend/backend/database/devops-engineer` → `software-engineer`, `manual/automation-qa-engineer` → `qa-engineer` (khoá cũ báo `CONFIG_INVALID` kèm tên khoá cần đổi). Không có `--profile`: truyền cho `claude` qua `--model`/`--effort` (frontmatter agent chỉ là default, trùng schema); có profile thì profile quyết định |
| `agents.contractRepairs` | `2` | Số lần runtime resume ngay session của lần chạy để agent sửa kết quả `CONTRACT_INVALID` (parse hoặc "claims do not match the worktree") trước khi BLOCKED; `0` = BLOCKED ngay như trước. 0–5 (DevTask-0142 #407) |
| `agents.sessionMaxTokens` | `3000000` | Tổng token input (gồm cache read/creation) cộng dồn của một session role; vượt thì lần chạy sau dùng session mới với packet đầy đủ và report ghi lý do. Mặc định ≈ 50 turn × 60k context; tối thiểu 10000 |
| `setup` | không có | `{ run, timeoutSec }` (như một check), ví dụ `{ run: npm ci }`. `omi task start` chạy trong clone mới trước agent và check; dùng lại clone thì chạy lại chỉ khi lockfile (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`) hoặc lệnh đổi. Lỗi/quá hạn: `SETUP_FAILED`, log đã redact ở `evidence/<run>/setup/setup.log`, không chạy agent. `omi github project init` tự ghi `setup: { run: npm ci }` khi repo có `package-lock.json`; `omi doctor` báo mục `setup` |
| `checks.<format\|lint\|build\|test\|scan>` | không có | `{ run, timeoutSec }` (timeout mặc định 600 s); tên khác bị từ chối. Không khai báo = không có gate xác định |
| `cleanup.deleteRemoteBranch` | `false` | Dự phòng: cleanup hiện không xoá branch remote dù đặt `true` |
| `cleanup.logRetentionDays` | `14` | Evidence cục bộ |
| `context.keep` | `[]` | Mục context PO muốn giữ (tên plugin/skill/MCP server, đường dẫn memory file); `omi context plan` coi là cần |

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

Với `github.model: v2` các bước trên không ghi Status trực tiếp: `omi move <n> "In progress"` trước khi giao việc cho agent (`task start`, `task analyze`), và `omi sync` sau khi agent trả kết quả (`task run`, `task analyze`), sau `task unblock`, `pr create`, `pr merge`, `task finalize`, `release tag` (In review, Done, roll-up cha và đóng Issue do luật `auto`). Xem `github-project-v2-setup.md` mục 7.

Context của agent (`issueContext` trong packet): Issue của task, chuỗi Issue cha, rồi các Issue khai trong section `## Sources` của body task (tùy chọn; mỗi dòng `#n` hoặc `owner/repo#n`, tối đa 4 Issue, mỗi Issue ≤ 6 000 ký tự, tổng ≤ 16 000, đã redact; Issue không đọc được thì bị bỏ qua). Dùng khi spec nằm ngoài chuỗi cha (vd. ChangeRequest ở nhánh khác của cây) thay vì chép tay. `omi ticket validate` cảnh báo (`references`, không chặn) khi body dẫn `#n` ngoài chuỗi cha và không có trong `Sources`. Body Issue vượt 12 000 ký tự: packet giữ Objective/Scope/Acceptance/Definition of Done, rồi các section `<!-- omi:section=… -->` (analysis, architecture, design…), rồi phần còn lại, theo thứ tự trong body; phần bị bỏ hoặc cắt nằm trong `omitted` của entry (tên section + số ký tự). Agent cần phần đó thì trả `BLOCKED` xin thêm, không tự đoán.

Finding hoãn sang task khác: comment `<!-- omi:carried-findings=<ID> -->` trên Issue đích; `omi issue findings <n>` liệt kê khi bắt đầu. Tổng quan: `omi status`. Cuối phiên: `omi handoff post --body-file <f>`; đầu phiên: `omi handoff show` (skill `omi-resume`).

### Năm role agent (DevTask-0131 #382, ADR-0005 D4)

Role thực thi: `software-engineer`, `qa-engineer`, `ui-ux-designer`, `code-reviewer`, `security-reviewer`; `business-analyst` chỉ do `omi task analyze` chọn; `solution-architect` do `omi task analyze` chọn và chạy ở bước leo thang review của `omi task run` (sau 2 round FAILED; quyết định PO 2026-11-23, #382 CR-002). Một kế hoạch delivery không bao giờ chứa BA hay Architect. Áp cho cả `github.model: legacy` lẫn `v2`. Ánh xạ legacy: `role:frontend|backend|database|devops` (vẫn được chấp nhận, chỉ một nhãn) và type `dev-task`/`devops-task`/`documentation-task` → `software-engineer`; type `test-task` → `qa-engineer`. `agents.routing.<role>` và `--skills <role>=…` dùng tên role mới (`omi skill list`).

Quyền tool: engineer chạy được `git mv` và `npm run check|arch|test|format` (có hoặc không đối số) ngoài các lệnh `checks` của repo; reviewer không có lệnh đọc shell (`grep`, `cat`, `head`, `tail`, `wc` đã gỡ, DevTask-0138 #395, Bug-0012 #391): reviewer đọc bằng tool Read/Grep/Glob của harness (giới hạn trong task workspace) và git chỉ đọc `git show|diff|log|status`. Vẫn cấm `git add|commit|push` và mọi `gh`.

Luật git của hook agent (`omi hook agent-pre-tool-use`, áp cho mọi agent; quyết định PO 2026-11-23 sau DevTask-0136 #393: luật cấm theo token, không theo dõi `cd`/subshell/symlink): trong mọi segment `git` (kể cả `git.exe`, sau `VAR=x`) cả lệnh bị từ chối (`OMI: agents run git only on paths inside their task workspace.`) khi có: `--no-index`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`, `--output`; `-C` với thư mục khác repo của task (`OMI_REPO` trong `.claude/settings.json` của workspace); tham số có thành phần đường dẫn `..` (kể cả `HEAD:../x`, `--opt=../x`), tham số tuyệt đối (`/`, `\\`, `X:`) hoặc bắt đầu bằng `~`; ký tự `$`, backtick, `{`, `}`, `*`, `?`, `[`, `<`, `>` (và `\` trong Bash); `GIT_*=` làm tiền tố. Ref như `origin/develop...HEAD`, `HEAD~1`, `abc123:path` vẫn hợp lệ. Một `cd` trong lệnh có git cũng bị cấm khi trỏ ra ngoài (`..`, tuyệt đối, `~`, trơn, `-`). Hook không theo dõi `cd` và không resolve symlink: một symlink trong workspace trỏ ra ngoài không bị bắt. Luật token dựa vào harness giữ thư mục làm việc của Bash trong task workspace giữa các lần gọi (Claude Code đặt lại cwd đã ra ngoài); thiếu giả định này, tham số git tương đối không còn bị giới hạn. Trong lệnh có từ `git` (khớp theo từ, không phải `github`/`.gitignore`), chỉ segment `git` thuần và `cd <dir>` tương đối thuần được chạy; wrapper, `(`/`{`/`!`, popd/source/eval, CDPATH làm cả lệnh bị từ chối.

### Session agent (DevTask-0142 #407)

Mục tiêu: một workflow trên một ticket tốn ít quota nhất. Runtime chạy `claude -p --agent … --output-format stream-json` như cũ, thêm `--session-id <uuid>` (lần đầu) hoặc `--resume <uuid>` (chạy lại) thay cho `--no-session-persistence`. Session nằm dưới `CLAUDE_CONFIG_DIR = <taskRoot>/.omi-home/claude` (thư mục này không còn bị xoá mỗi lần chạy), nên `omi task finalize` dọn cùng workspace; không có vị trí ngoài workspace.

- **Theo role trong run**: bảng `agent_session (run_id, role, session_id, tokens, context_hash)` (migration 13) chỉ cho `software-engineer` và `qa-engineer`. Code/Security Reviewer, Architect và các role phân tích luôn session mới (review độc lập); chúng chỉ được resume để sửa lỗi contract của chính lần chạy đó.
- **Resume khi chạy lại cùng role**: sửa sau `CHECKS_FAILED`, sau finding review, `implement-fix`, sau `omi task unblock`, sau hết quota. Prompt chỉ gồm định danh bước, finding mở, kết quả check (đã redact), lý do unblock (`--reason`, đọc một lần) và `issueContext` khi Issue đổi (so băm); không gửi lại packet. `--agent`, `--allowedTools`, `--model`/`--effort` vẫn truyền lại. Packet và contract kết quả không đổi.
- **Tự sửa contract**: kết quả `CONTRACT_INVALID` → resume session đó với danh sách issue, tối đa `agents.contractRepairs` lần, rồi mới BLOCKED. Mọi role.
- **Fallback = session mới + packet đầy đủ**: session vượt `agents.sessionMaxTokens`, hoặc resume không nạp được session: lần resume lỗi (`is_error`) mà không có usage, hoặc `num_turns` = 0, hoặc kết quả chứa "No conversation found with session ID". Lỗi thường của agent (hết turn, lỗi trong lúc làm việc) không phải tín hiệu này và không chạy lại bằng session mới. Lý do ghi ở dòng Cost của report (`session new — …`).
- **Report**: dòng Cost thêm `session new|resumed|repair` (`repair` = đã resume để sửa contract, kèm số lần); usage/cost của một step là tổng các lần chạy của step đó (kể cả lần sửa), mỗi step vẫn tính riêng.
- **Probe** (`OMI_LIVE=1 npm test -- tests/integration/task-run/session-probe.test.ts`; (c) cần `OMI_PROBE_TOKEN_2`): (a) `--session-id` lưu session dưới `CLAUDE_CONFIG_DIR`; (b) `--resume` nhớ nội dung lần đầu; (c) resume với `CLAUDE_CODE_OAUTH_TOKEN` của profile khác; (d) `--model` truyền lại khi resume có hiệu lực. Kết quả chạy live trên Claude Code 2.1.325 (Coordinator, 2026-11-23, hai token profile khác nhau). Nhánh nào không đạt không cần đổi code: runtime coi lỗi resume là fallback session mới.

| Probe | Kết quả |
|---|---|
| (a) `--session-id` lưu dưới `CLAUDE_CONFIG_DIR` | ok |
| (b) `--resume` nhớ lần đầu | ok |
| (c) resume với token profile khác | ok (`isError=false remembers=true`) |
| (d) `--agent`/`--allowedTools`/`--model` khi resume | ok |
| (d2) tool ngoài `--allowedTools` vẫn bị từ chối sau `--resume` | ok |

## 6. Escalation và khôi phục

| Tình huống | Dấu hiệu | Xử lý |
|---|---|---|
| Agent/check báo BLOCKED, hoặc hết `maxAttempts` lỗi tạm thời | Status Blocked, `omi task status <n>` = BLOCKED, report BLOCKED trên Issue | Người quyết định, rồi `omi task unblock <n> --reason <text>` và `omi task run <n>` |
| Hết 4 round review hoặc Architect báo đổi phạm vi | Status Waiting PO, comment escalation | PO quyết định; task workspace được giữ. Không có lệnh resume: PO tạo work item mới (Change Request / DevTask) hoặc đóng Issue. Không chạy round thứ 5 |
| PR đã merge nhưng cleanup lỗi | `task finalize` exit 1, run CLEANUP_FAILED, Status Blocked | Đọc report cleanup trên Issue; sửa nguyên nhân (clone bẩn hoặc chưa push: commit/push hoặc chuyển thay đổi đi; file lạ trong task workspace; file đang bị khoá; path lạ) rồi chạy lại `omi task finalize <n>`. Không `--force` |
| Phiên crash giữa chừng | `omi cleanup scan` thấy attempt mở, report chưa đăng, task đã merge chưa dọn | `omi cleanup apply --safe` (`cleanup scan` ghi "crashed (process gone)" khi PID của attempt đã chết, và "unknown (no PID)" cho attempt tạo trước cột PID) |
| Report không đăng được | outbox pending; bước không tiến | Lỗi tạm thời: chạy lại lệnh; lỗi quyền: sửa token rồi chạy lại |
| Status Blocked nhưng `task status` là RECOVERY_REQUIRED hoặc FAILED | `task unblock` báo INVALID_TRANSITION | CLI hiện không tự đưa run vào hai state này; không sửa DB tay, báo maintainer kèm `omi task status <n> --output json` |
| Hai phiên cùng một Issue | `LOCK_HELD` (exit 75) | Đợi phiên kia, không xoá lease |

## 7. Rate limit và lỗi tạm thời

Lỗi tạm thời (`GITHUB_RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `NETWORK`, `LOCK_HELD`, `REPORT_NOT_POSTED`, `CRASH_RECOVERED`) thoát mã `75`: chạy lại lệnh sau. Trong `task run`, mỗi lỗi tạm thời là một attempt mới của cùng bước; hết `review.maxAttempts` thì run sang BLOCKED. `omi doctor` cảnh báo khi còn < 10% quota (kèm giờ reset); xem nhanh: `gh api rate_limit`. Attempt không tính là round review. `GITHUB_AUTH` (401/403/thiếu scope) không tự hết: sửa token.

## 8. Xoá an toàn

- OMI chỉ xoá thứ nó sở hữu và đã xác minh (task workspace sạch, chỉ chứa file OMI sinh ra, tip của clone khớp receipt merge của GitHub), không bao giờ `--force`, không xoá branch remote.
- Task workspace mồ côi (`cleanup scan` báo `orphan`: `<workspace>-task-*` không thuộc run nào đang mở) không bị xoá tự động. Người kiểm tra nội dung (commit chưa push?) rồi tự xoá thư mục.
- Profile (ADR-0007) nằm ở DB cấp máy `profiles.sqlite`, dùng chung mọi workspace của user OS:
  - Đường dẫn: win32 `%LOCALAPPDATA%\omi\profiles.sqlite`; darwin `~/Library/Application Support/omi/profiles.sqlite`; còn lại `${XDG_CONFIG_HOME:-~/.config}/omi/profiles.sqlite`. `OMI_PROFILE_DB` (đường dẫn tuyệt đối tới file, tương đối → `CONFIG_INVALID`) ghi đè.
  - Quyền file: POSIX thư mục `0700`, `profiles.sqlite`/`-wal`/`-shm` `0600`, `omi doctor` kiểm. Windows dựa vào ACL của `%LOCALAPPDATA%`.
  - Không đặt trên network share (khóa ghi WAL không đáng tin). Tranh chấp ghi quá 5 giây → `LOCK_HELD`, thử lại.
  - Chưa có file thì chưa có profile; lệnh đọc không tạo file, `add`/`set-token`/`import` tạo. Sao lưu: copy `profiles.sqlite` (cùng `-wal`).
  - Workspace cũ còn profile trong `state.sqlite`: mọi lệnh profile/secret báo `CONFIG_INVALID` tới khi chạy `omi profile import` (xem [migration](./workspace-migration.md#5-chuyển-profile-lên-db-cấp-máy)). Tên trùng khác nội dung → `CONFIG_CONFLICT`; chọn bằng `omi profile import --resolve <name>=machine|workspace` (lặp được); `--dry-run` xem kế hoạch.
  - Master key (`OMI_SECRET_KEY`) phải giống nhau ở mọi workspace; lệch → `SECRET_KEY_MISMATCH`. `omi secret rotate-key` đổi key cho cả máy.
- State cục bộ ở `<workspace>/.omi-plugins/state.sqlite` (dùng chung mọi task workspace, ngoài repo). Không xoá khi còn run mở; xoá là mất lịch sử run và outbox chưa đăng.

## 9. Release

Skill `/omi-coordinator:omi-release`:

1. Một DevTask đặt cùng version semver mới vào `.claude-plugin/plugin.json` và `package.json`, đổi `## [Unreleased]` trong `CHANGELOG.md` thành `## [<version>] - <ngày>`; merge vào `develop`.
2. Release Issue (`omi issue create --type release --parent <Milestone> …`), rồi `omi release check <n>` tới khi mọi dòng PASS.
3. `omi pr create <n>` mở PR `develop → main`; **PO merge**.
4. `omi release tag <n>`: tag `<plugin>--v<version>` (`omi-coordinator--v…`) trên merge commit, push, đóng Release Issue.

Người dùng cài/update/rollback theo tag: [README](../../README.md#cài-plugin). Trước khi update, sao lưu `state.sqlite`: migration chỉ đi tiến và bản cũ từ chối DB mới hơn; rollback qua một migration thì khôi phục bản sao lưu.
