# 归档清单

- 归档名称：ClodStorageAgent Demo 业务逻辑基线
- 版本：`v1.0.0-demo-baseline`
- 冻结日期：2026-11-19
- 状态：Demo 业务逻辑验收通过，规则冻结
- 用例数：49（12 个模块）
- 日志文件：10（含说明 README）
- 源码快照：18 个文件（TypeScript 源码 + package/tsconfig/accounts/README/.env.example/SNAPSHOT_INFO）
- 文档文件：8

## 验收核对

| 项 | 结果 |
|---|---|
| `03_regression_cases.json` JSON 解析 | 通过，49 条 |
| 模块覆盖 | 12 个 |
| `npx tsc --noEmit` | 通过 |
| 柚子内置温湿度 reviewer 严格 Mock 复测 | 通过 |
| 库房前置核验/无合格库房/超时/吨位偏差/热物性历史 | 本次调试通过 |
| 冻结规则中被废止项 | 已列入 `CHANGELOG.md`，不进入回归期望 |
| 密钥/`.env` | 未归档 |

## 文件结构

```text
archive/
├── README.md
├── 01_requirements_baseline.md
├── 02_rules_and_boundaries.md
├── 03_regression_cases.md
├── 03_regression_cases.json
├── 04_test_evidence.md
├── 05_platform_architecture_input.md
├── CHANGELOG.md
├── MANIFEST.md
├── SHA256SUMS.txt
├── logs/
│   ├── README.md
│   ├── 01_room_precheck.log
│   ├── 02_precheck_fail_reselect.log
│   ├── 03_no_room.log
│   ├── 04_fruit_spec_reviewer.log
│   ├── 05_tonnage_only.log
│   ├── 06_arrival_replan.log
│   ├── 07_timeout_rebook.log
│   ├── 08_rectification.log
│   └── 09_cop_q1.log
└── source-snapshot/
    ├── .env.example
    ├── SNAPSHOT_INFO.md
    ├── accounts.json
    ├── package.json
    ├── README.md
    ├── tsconfig.json
    └── src/
```

## 校验方式

```text
node -e "JSON.parse(require('fs').readFileSync('archive/03_regression_cases.json','utf8'))"
npx --prefix ClodStorageAgent tsc --noEmit -p ClodStorageAgent/tsconfig.json
Get-FileHash -Algorithm SHA256 <file>
```

## 使用约束

- 本目录为冻结基线，不原地修改规则。
- 新版本另建目录（如 `archive-v1.1.0`），保留旧版本。
- 平台回归必须使用 `03_regression_cases.json` 当前冻结版本。
- 日志为关键片段，完整原始控制台输出未全部持久化；详见 `logs/README.md`。
- 源码快照不含 `.env`、`node_modules`、测试临时目录和编译产物。
