# Runbook: bật contract kiến trúc cho repo đích

Liên quan: Feature-0043 #321, [ADR-0006](../decisions/ADR-0006-kien-truc-feature-module-va-contract.md), DocumentationTask-0018 #336. Mô tả cấu trúc của chính `omi-plugins`: [overview](../architecture/overview.md).

Contract kiến trúc là file `omi-architecture.yaml` nằm **trong repo** (ADR-0006 D3), khai báo module theo chức năng, lớp, hướng phụ thuộc và nơi đặt file. `omi arch check` kiểm tất định, không dùng LLM, không gọi mạng.

## 1. Tạo contract

Tạo `omi-architecture.yaml` ở gốc repo đích. Ví dụ tối thiểu cho repo TypeScript có hai module `billing` và `orders`, `orders` được phép import `billing` (`dependsOn: [billing]`):

```yaml
schemaVersion: 1
stack:
  languages: [typescript]
  importParser: ts-js        # ts-js | none
  extensions: [".ts", ".js"] # mặc định: .ts .js .mts .mjs
sourceRoots: [src]
layers:
  - { name: domain, dir: domain, mayImport: [], forbidPackages: ["node:fs", "node:child_process"] }
  - { name: application, dir: application, mayImport: [domain] }
  - { name: adapters, dir: adapters, mayImport: [application, domain] }
  - { name: cli, dir: cli, mayImport: [adapters, application, domain] }
modules:
  - { id: shared, path: src/shared, description: "Shared kernel", shared: true }
  - { id: billing, path: src/billing, description: "Billing rules and invoices" }
  - { id: orders, path: src/orders, description: "Order lifecycle", dependsOn: [billing] }
entrypoints:
  - { path: src/main.ts, mayImport: cli }
placement:
  - pattern: "**/*.test.ts"
    allowedIn: ["tests/**"]
    message: "Tests live under tests/, never next to the source."
```

Ý nghĩa các khóa:

| Khóa | Ý nghĩa |
|---|---|
| `stack` | ngôn ngữ và parser import (`ts-js` hoặc `none`), `extensions` là đuôi file được quét import |
| `sourceRoots` | thư mục mã nguồn (tương đối, posix); thư mục `tests/` luôn được quét thêm để áp `placement` |
| `layers` | mỗi lớp là một thư mục con của module (`dir`); `mayImport` là các lớp khác mà nó được import; `forbidPackages` cấm package (kể cả `node:`) |
| `modules` | `path` không lồng nhau; `dependsOn` là module khác được import; `shared: true` là shared kernel (không import module nào, ai cũng import được) |
| `entrypoints` | composition root; `mayImport: cli` chỉ cho import lớp `cli` của module |
| `placement` | `pattern` chỉ được nằm trong `allowedIn` (glob) |
| `ignore` | glob file bỏ qua hoàn toàn |
| `legacy` | chuyển đổi có thời hạn (mục 4) |

Contract được kiểm bằng schema strict: field lạ, layer/module trùng, `dependsOn` trỏ module chưa khai báo, `dependsOn` có chu trình, shared phụ thuộc module không shared, hoặc đường dẫn có `..`, tuyệt đối, `\` đều bị từ chối với `CONTRACT_INVALID`. Muốn đặt contract ở đường dẫn khác, khai báo trong `omi.config.yaml` của workspace: `architecture.contract` (đường dẫn tương đối, chỉ gồm chữ, số, `_`, `.`, `/`, `-`).

### Stack không phải TypeScript/JavaScript

Đặt `importParser: none`. Check chỉ kiểm **placement** và **module/lớp** (file nằm ngoài module đã khai báo, file không nằm trong thư mục lớp), không kiểm import. Khai báo `languages` đúng stack của repo; `extensions` không dùng khi `none`.

## 2. Chạy check

```text
node bin/omi arch check --repo <repo> [--contract <relPath>] [--output text|json]
```

Exit 0 khi sạch. Có vi phạm thì exit 1 với `ARCH_VIOLATION`, mỗi vi phạm một dòng:

```text
<file>:<dòng> [<rule>] <thông điệp> Sửa: <cách sửa>
```

`omi arch show [--scope <relPath>…]` in phần contract liên quan (cùng bản trích mà task packet mang cho agent).

## 3. Đọc thông điệp sửa

| Rule | Nghĩa | Cách sửa |
|---|---|---|
| `undeclared-module` | file dưới `sourceRoots` không thuộc module, `legacy` hay `ignore` nào | Architect thêm module vào contract, hoặc chuyển file vào module đã khai báo |
| `undeclared-layer` | file của module không nằm trong thư mục lớp nào | chuyển vào `<module>/<lớp>/` |
| `placement` | file khớp `pattern` nhưng ngoài `allowedIn` | chuyển vào một trong các thư mục `allowedIn` |
| `boundary` | module A import module B không có trong `dependsOn` của A | thêm B vào `dependsOn` của A (không tạo chu trình) hoặc bỏ import và truyền phụ thuộc từ `cli` |
| `layer` | lớp import lớp không được phép theo `mayImport` (hoặc entrypoint import ngoài lớp `cli`) | đưa phụ thuộc thành port ở lớp được phép, truyền từ `cli` |
| `forbidden-package` | lớp import package trong `forbidPackages` | bỏ import khỏi lớp đó, đưa vào `adapters` và truyền qua port |
| `unresolved-import` | import tương đối không resolve được tới file trong repo (hoặc ra ngoài repo) | sửa đường dẫn |

Báo cáo tối đa 500 vi phạm (`truncated`). Contract thiếu hoặc sai schema là `CONTRACT_INVALID`, không phải `ARCH_VIOLATION`.

## 4. Dùng `legacy` khi chuyển đổi

Repo đã có code cũ chưa theo cấu trúc: không nới contract, ghi thư mục chưa chuyển vào `legacy`. File dưới `path` đó được bỏ qua khi kiểm.

```yaml
legacy:
  - { path: src/old-utils, issue: 123, reason: "Chuyển vào module billing" }
```

Quy tắc: mỗi mục gắn một Issue theo dõi (`issue` là số nguyên dương), có `reason` (≤ 200 ký tự), và được xóa ngay khi thư mục chuyển xong. `omi doctor` cảnh báo (`warn`) khi `legacy` còn phần tử. Mục tiêu là `legacy: []` (như `omi-plugins` sau Feature-0043 #321). Không dùng `legacy` để che vi phạm của code mới.

## 5. Check chạy ở đâu

- **Gate `omi task run`**: khi worktree có contract (file hoặc symlink, để check báo symlink là không hợp lệ), gate tự chạy check `architecture` cùng chỗ lint/typecheck/test; không có contract thì `skipped`. Vi phạm làm gate fail, Engineer nhận thông điệp sửa trong round sửa. Gán lệnh riêng bằng `checks.architecture` trong `omi.config.yaml` thì lệnh đó thay check mặc định.
- **`omi doctor`** (check `architecture`): không có contract là `warn` kèm link runbook này; contract sai hoặc có vi phạm là `fail` (hiện tối đa 5 vi phạm, phần còn lại chạy `omi arch check`); còn `legacy` là `warn`; sạch là `pass`.
- **Agent**: task packet mang bản trích contract theo scope; Code Reviewer kiểm theo contract, Architect cập nhật contract khi thêm module (`agent-pack/agents-md/`, ADR-0006 D5).
- **Repo của chính `omi-plugins`**: `npm run check` gồm `npm run arch`.

## 6. Giới hạn

- Parser import chỉ hỗ trợ TypeScript/JavaScript (`importParser: ts-js`); stack khác dùng `none` (mục 1).
- `import()` động mà đối số không phải string literal **bị bỏ qua**; `import("./x.ts")` literal và `require("./x")` literal được kiểm.
- Specifier bare và `node:` (package) **chỉ kiểm qua `forbidPackages`** của lớp; không có luật module/lớp cho package ngoài.
- Alias đường dẫn (`paths` của tsconfig, `exports` của package) không resolve: import qua alias không được kiểm ranh giới. Dùng import tương đối cho code trong repo.
- Symlink không được theo; file lớn hơn 2 MB bị bỏ qua khi quét import; thư mục `node_modules` và `.git` bị bỏ qua.
- **CI của repo đích chưa được bật.** Repo đích chỉ bị chặn ở gate `omi task run` (ADR-0006 D4, ARC-003); chạy `omi arch check` trong CI của repo đích là follow-up ngoài Feature-0043. Repo cần CI sớm có thể tự thêm bước chạy `node <plugin>/bin/omi arch check`.

## Lỗi thường gặp

- `CONTRACT_INVALID`: contract thiếu, sai schema, là symlink ra ngoài repo, hoặc `sourceRoots` trỏ tới thư mục không có, là symlink hay ra ngoài repo. Thông điệp nêu field sai.
- `ARCH_VIOLATION`: làm theo cột "Sửa" của dòng vi phạm (mục 3).
