# ADR-0003 — Rules, skills, hooks và Coordinator mỏng

- **Trạng thái:** Accepted. PO duyệt phạm vi qua ChangeRequest-0002 #184 (2026-11-19); điểm kỹ thuật đã kiểm chứng ở Spike-0010 #185. Thay ADR-0002 D4 và phần workflow tùy chọn của ADR-0001. Triển khai ở Feature-0026 #187, Feature-0027 #188, Feature-0028 #189, Feature-0029 #190 (Milestone-0010 #182). D2 được làm rõ bởi [ADR-0005](./ADR-0005-quy-trinh-github-project-moi.md) D3: Coordinator chịu trách nhiệm BA/Architect/DevOps nhưng việc nặng (PRD, Architecture, ADR) vẫn chạy agent ẩn qua `omi task analyze`; bộ 11 role agent nhắc trong ADR này rút còn 5 role theo ADR-0005 D4.
- **Ngày:** 2026-11-19
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Nguồn:** [ChangeRequest-0002 #184](https://github.com/omi-home/omi-plugins/issues/184) (Feature-0025 #183)
- **Bằng chứng:** comment `omi:evidence=Spike-0010` trên [Spike-0010 #185](https://github.com/omi-home/omi-plugins/issues/185)
- **Môi trường:** Claude Code `2.1.325`, Windows 11

## Bối cảnh

Coordinator làm mọi việc trong một phiên chính: đọc code, sửa code, chạy test, đọc log. Context đầy nhanh nên phải compact hoặc mở phiên mới liên tục, và đổi model giữa chừng gây bất tiện. Lúc bắt đầu, phiên chính đã nạp khoảng 35k token, phần lớn từ plugin, skill, MCP và hook cấp user. Plugin `omi-engineering` mang cả skill của Coordinator lẫn 11 agent. Kiến thức chuyên môn bị chép toàn văn vào `AGENTS.md` của task workspace theo `omi:rule-pack` (ADR-0002 D4), và agent đặt `disallowedTools: Skill`. PO muốn tối ưu quota: mỗi phiên chỉ nạp đúng thứ cần, việc nặng chạy ngoài phiên chính.

## Quyết định

| # | Chủ đề | Quyết định |
| --- | --- | --- |
| D1 | Phân lớp | **Rules** (`AGENTS.md`, `.claude/rules/*.md`): điều luôn phải tuân thủ, nạp mọi phiên, phải ngắn. **Skills**: cách làm một việc, chỉ phần mô tả nằm sẵn trong context, nội dung nạp khi cần. **Hooks / CLI gate**: điều không được vi phạm, thực thi tự động. **`omi` CLI**: mọi side effect (Git, GitHub, state, cleanup). Điều bắt buộc tuyệt đối đặt ở hook hoặc CLI gate, không viết thêm rules để nhắc. |
| D2 | Coordinator mỏng | Coordinator chỉ điều phối: không đọc/sửa code trong repo, không đọc log dài. Việc của Engineer/Reviewer đi qua `omi task run` (tiến trình `claude -p` riêng); phiên chính nhận kết quả có cấu trúc ngắn. Phiên chính giữ một model; model/effort theo step do profile quyết (ADR-0002 D12). Output CLI mặc định gọn, log dài vào `evidence/`. Áp dụng cho workspace `omi-plugins` khi bộ mới hoàn thiện và đã cài plugin mới. |
| D3 | Đóng gói | Một repo, một marketplace, **một lần cài**. Plugin cài trong workspace là `omi-coordinator` (skills `/omi-*`, hooks, rules của Coordinator, `bin/omi`). Gói agent `omi-engineering` nằm trong `agent-pack/` của plugin đó (`.claude-plugin/plugin.json`, `agents/`, `skill-library/`), không cài riêng. CLI chạy agent bằng `--plugin-dir <plugin root>/agent-pack`; agent giữ tên `omi-engineering:<role>`. Đã kiểm chứng: phiên có plugin không quét `agent-pack/agents` hay `skill-library/`; bản cài trong cache giữ nguyên `agent-pack/`. |
| D4 | Skill của agent | Kiến thức chuyên môn là skill trong `agent-pack/skill-library/<skill>/SKILL.md`. Mỗi role khai báo tập skill được phép và mặc định tối thiểu. Mỗi step, Coordinator chọn vài skill (cùng profile/model/effort, kèm lý do); CLI từ chối skill ngoài tập của role, ghi lựa chọn vào state và báo cáo, rồi **chỉ chép skill đã chọn** vào `.claude/skills/` của task workspace. Agent có tool `Skill`, thấy mô tả và tự nạp khi cần. Không dùng `disallowedTools: Skill` (agent vẫn đọc được `SKILL.md` bằng `Read`) và không dùng `skills:` trong frontmatter (không nạp sẵn khi chạy bằng `--agent`). Thay ADR-0002 D4. |
| D5 | Rules | Coordinator: `AGENTS.md` của workspace chỉ giữ vai trò và nguyên tắc; quy trình, đặt tên Issue, Memory ở `.claude/rules/*.md`. Agent: `AGENTS.md` sinh theo role chỉ gồm Definition of Done, ranh giới, format REPORT, phần cố định đặt đầu để tăng cache hit; quy ước theo vùng code dùng `.claude/rules/*.md` có frontmatter `paths` (chỉ nạp khi agent đọc file khớp). |
| D6 | Hooks | Khai báo trong `hooks/hooks.json` của plugin (và của `agent-pack`). `PreToolUse` chặn cứng (exit 2 + lý do): Coordinator sửa file trong repo chính, commit vào `develop`/`main`, `--force`; agent `git push`, `gh`, ghi ra ngoài task workspace. `SessionStart` (`startup`/`resume`/`compact`) chèn tóm tắt ngắn (handoff + trạng thái Milestone) từ một lệnh `omi` chỉ đọc. |
| D7 | Bỏ workflows | Mọi điều phối đi qua `omi task run` (FSM, state SQLite, chạy lại được, có profile). Cần chạy song song thì CLI chạy nhiều tiến trình `claude -p`. Bỏ `workflows/`, adapter workflow và check `workflows` của `omi doctor`. |
| D8 | `omi context plan\|apply` | `plan` (chỉ đọc) đo `/context` qua `claude -p` ở workspace và task workspace của từng role, phân loại từng mục kèm số token, so sánh bằng tổng `Tokens`. `apply` chỉ ghi `.claude/settings.json` của workspace, không bao giờ sửa `~/.claude`, có `--dry-run`, chạy lại an toàn, gỡ được. Chỉ dùng setting đã kiểm chứng: `enabledPlugins: {"<id>": false}` (tắt cả id `@synced` cùng tên), `skillOverrides` (`off`/`name-only`/`user-invocable-only`), `disableClaudeAiConnectors`, `deniedMcpServers`, `disableBundledSkills` (khi PO đồng ý). Không đặt chỉ tiêu số token cố định. |
| D9 | Usage | Mỗi lần chạy agent lưu `usage` (input, output, cache read/creation, thinking), `total_cost_usd`, `num_turns` vào state; `omi status` hiển thị theo task/step/profile. Cost qua gateway là ước tính theo giá niêm yết. |

## Hệ quả

- Thay ADR-0002 D4 (rule pack chép vào `AGENTS.md`, `disallowedTools: Skill`). D1–D3, D5–D12 của ADR-0002 giữ nguyên.
- Thay phần "Workflow tùy chọn" của ADR-0001.
- `resources/role-rules/`, `resources/shared/` và `omi:rule-pack` bị bỏ khi Feature-0027 #188 xong; `agents/` chuyển vào `agent-pack/agents/` ở Feature-0026 #187.
- `docs/architecture/overview.md`: hợp đồng thư mục có `hooks/`, `agent-pack/`; `workflows/` và `resources/` đánh dấu sẽ bỏ.
- Rủi ro: chuyển bộ cũ sang bộ mới phải giữ chất lượng review (so sánh bằng probe `OMI_LIVE=1`); hook sai có thể chặn nhầm; `apply` tắt plugin cấp user cho workspace nên luôn có `--dry-run`.
