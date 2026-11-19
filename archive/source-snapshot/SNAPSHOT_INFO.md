# ClodStorageAgent Demo 归档快照

- 冻结日期：2026-11-19
- 基线版本：v1.0.0-demo-baseline
- 说明：本快照来自调试验收通过的 Demo 源码，保留 TypeScript 源码、package.json、tsconfig.json、accounts.json 和 README。
- 已排除：node_modules、.env（含密钥）、测试临时目录、编译产生的 .js 副本、.dist-full。
- 运行：`npm install` 后执行 `npm start`；环境变量参见 `.env.example`。
- 注意：`accounts.json` 为演示账号数据，不包含密码；平台化后必须替换为正式认证与授权。
