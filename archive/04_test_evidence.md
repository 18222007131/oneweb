# 调试证据与日志索引

- 版本：`v1.0.0-demo-baseline`
- 验证日期：2026-11-19
- 验证方式：CLI + LangGraph + 本地 PLC 模拟 + DeepSeek Mock（严格校验 payload）+ `npx tsc --noEmit`
- 说明：本文件记录本次 Demo 调试验收通过的关键证据。`logs/` 为实际输出的关键片段，不是完整逐行终端日志；未保存的原始输出不在此伪造。

## 1. 验证环境

- 时区：Asia/Shanghai
- Node.js：24.x
- TypeScript：通过 `npx tsc --noEmit`
- DeepSeek：Mock 模式，可配置为“缺少内置温湿度参数”严格失败，用于验证修复
- PLC：本地模拟样本；支持固定样本注入
- 状态：LangGraph MemorySaver
- 测试数据：6 间库房，A1/A2 杨梅，B1/B2 柚子，C1/C2 苹果；B2 初始占用；总库容 2000t

## 2. 关键证据

### 2.1 库房硬预选与前置核验（IN-003、IN-004、IN-008）

证据：`logs/01_room_precheck.log`

实际结果：

- A1/A2：品类不匹配 + 温区不匹配，淘汰；
- B1：通过；
- B2：已占用，淘汰；
- C1/C2：品类不匹配 + 温区不匹配，淘汰；
- 最终候选仅 B1；
- reviewer 前置核验通过后才交给 master；
- 用户确认 B1 后，预约单审核通过并标记占用。

断言：

```text
candidateCodes = [B1]
precheckStatus = reviewer_passed
reviewPassed = true
occupancy(B1) = occupied
userVisibleBeforePrecheck = false
```

### 2.2 前置核验失败回退（IN-005）

证据：`logs/02_precheck_fail_reselect.log`

构造 B1 对杨梅温区/湿度不匹配：

```text
[reviewer] 前置快速核验不通过：B1(温区不匹配；湿度不匹配)；
           直接打回scheduler重选库房，不进入用户选择、不进入入库整改重试
[scheduler] 预选比对 B1 ... -> 淘汰（前置Reviewer已淘汰；温区不匹配；湿度不匹配）
[scheduler] 预选完成 ... 候选1间：A1 ... 送前置reviewer快速核验（第2次）
[reviewer] 前置快速核验通过：候选1间（A1 ...）
```

断言：

- 用户未收到 B1；
- `retryCount` 未增加（未进入普通整改）；
- 淘汰库房不参与第二轮候选；
- 第二轮通过后才展示 A1。

### 2.3 无合格库房（IN-006、PLC-004）

证据：`logs/03_no_room.log`

实际输出：

```text
[scheduler] 【暂时没有满足本次预约条件的合格库房】...
[scheduler] 暂无匹配库房，本次预约无法分配贮藏位置；已上报管理员。
           不合格库房不会进入reviewer或入库流程。
[master] 【暂时没有满足本次预约条件的合格库房】已上报管理员...
```

断言：

- `reviewer` 调用次数 = 0；
- 台账记录数 = 0；
- 未向用户展示候选；
- 设备异常导致同机组 A1/A2 不进入候选。

### 2.4 柚子内置温湿度与 reviewer payload（IN-007）

证据：`logs/04_fruit_spec_reviewer.log`

实际日志：

```text
[reviewer] 单据果品：柚子；单据温湿度要求：5~10°C/85%；内置要求：5~10°C/85%
[reviewer] 审核通过，结果返回scheduler
```

严格 Mock 行为：

- 若 reviewer LLM 请求中没有 `builtInFruitSpecs`，返回失败原因“预约单缺少内置温湿度参数”；
- 本次请求包含 `builtInFruitSpecs`（杨梅/柚子/苹果）和 `documentFruitSpec`，Mock 返回通过；
- 预约单字段完整：`tempZone`、`humidity`、`temperatureRequirement`、`humidityRequirement`、`tempMinC`、`tempMaxC`、`fruitSpec`。

断言：

```text
FRUIT_SPECS["杨梅"] = 0.5~2°C / 90%
FRUIT_SPECS["柚子"] = 5~10°C / 85%
FRUIT_SPECS["苹果"] = -1~0°C / 90%
doc.temperatureRequirement = "5~10°C"
doc.humidityRequirement = "85%"
payload.builtInFruitSpecs 存在
reviewer.reviewPassed = true
```

### 2.5 到货偏差只按吨位（IN-009、DEV-001、DEV-002、DEV-005、AUD-002）

证据：`logs/05_tonnage_only.log`

场景 A：预估 COP 后写回 q_resp 条件温度

```text
[xiaoke] 预约预估完成：【单库房COP】，Q1=315W...
[预约单] qRespConditionTempC=1.25℃
[thermalPlcHistory] source=estimate_cop，含 q_resp 和 PLC 快照
```

场景 B：到货 10t、货温 6℃（温度差异大，吨位一致）

```text
[xiaoke] 到货参数记录：...q_resp条件温度1.25℃；实际到货吨位10t、到货货温6℃；
         吨位偏差0%，阈值5%；温度仅记录不参与偏差判定
[scheduler] 小柯确认到货偏差已处理或未超过阈值，转reviewer审核
```

断言：未进入 `waiting_arrival_replan`；日志无“货温偏差”；`thermalPlcHistory` 新增到货记录，q_resp=1.25，PLC 非空。

场景 C：到货 12t、货温 5℃（吨位偏差20%）

```text
[xiaoke] 吨位偏差20%，阈值5%；温度仅记录不参与偏差判定
[xiaoke] 到货吨位偏差超过5%，...转master由库内人员选择增加库房或更换库房
```

断言：

```text
arrivalDeviation.deviations.tonnagePct = 20
arrivalDeviation.deviations.temperaturePct = undefined
thermalPlcHistory 记录 q_resp=5℃ + plcSnapshot
```

### 2.6 到货增加/更换库房（DEV-003、DEV-004）

证据：`logs/06_arrival_replan.log`

增加库房：

- 新单 `RK-...-R1`；
- `roomAllocations` 含 A1（原库房）和 A2（新增库房）；
- `addedRooms` 含 A2；
- 审核后 A1/A2 均占用；
- 未消耗普通整改次数。

更换库房：

- 新单库房 A2；
- 原库房 A1 释放；
- 预约单库房同步更新为 A2；
- A2 占用；
- 日志保留原始/实际/偏差/选择/新方案/新单号。

### 2.7 入库超时（TIM-001、TIM-002、TIM-003）

证据：`logs/07_timeout_rebook.log`

- 实际入库时间 > 预约时间 → 超时；
- 旧预约禁止直接入库；
- 不生成到货单、不进入 reviewer；
- 选择否：旧预约 `expired`/已失效，释放库房，流程结束；
- 选择是：旧预约作废释放，完整重跑预约→筛选→前置核验→用户选择→审核→台账。

### 2.8 reviewer 整改（REV-001、REV-002、REV-004）

证据：`logs/08_rectification.log`

- reviewer 返回具体原因；
- scheduler 向 master 确认整改指引；
- 每版修改并记录 `documentRevision`/`rectificationNotes`；
- 禁止原样重提；
- 正式模式 3 次兜底；演示模式 6 次；
- 达到上限终止，不写台账；
- 失败原因对用户可见。

### 2.9 COP 预约预估与 Q1（COP-001、COP-003、COP-004、COP-008、THERM-001）

证据：`logs/09_cop_q1.log`

实际日志：

```text
[xiaoke] 预约预估完成：【单库房COP】，Q1=315W，W=3294.5W，【预约预估值】COP=0.0956
[reviewer] COP核算结果质检通过，允许小柯制作报告
[master] COP核算报告已通过质检，正在输出给用户
```

断言：

- 无入库单 → 自动申请预约单；
- 不询问果品中心温度；
- 杨梅10t × 31.5W/t = 315W；
- q_resp 条件温度 1.25℃；
- 单库房 COP 标记正确；
- 报告含 Q1/W/COP/PLC/热物性来源/查表说明。

### 2.10 账号、菜单、资源队列、质检、PLC（历史调试证据）

以下模块在本次 Demo 调试期完成过验证，归档时未保留完整原始终端输出，按回归用例复核：

- ACC-001~005：账号自动登录/切换/退出/权限/台账过滤；
- MENU-001：任务完成后自动重打印菜单；
- QUE-001~003：PLC/LLM/ledger 串行、优先级、超时释放、控制台输入保护；
- COP-002/COP-005/COP-006/COP-007：机组分摊、Q2、三项质检/3轮、无单据警报；
- PLC-001~003：5分钟采样、2000条历史、5天均值、连续2小时长期异常；
- ALM-001/002：COP警报不阻塞到货/新预约、两类警报手动解除。

这些用例已纳入 `03_regression_cases.json`，平台回归时必须重新执行，不能仅依赖本次记录。

## 3. 类型检查

命令：

```text
npx tsc --noEmit
```

结果：通过，无输出。

## 4. 证据限制

- 本归档保留了关键日志片段，而非所有终端原始输出；
- 平台回归应使用固定时钟、固定 PLC 样本、固定 LLM mock，并按 `03_regression_cases.json` 的 `expected` 做结构化断言；
- 若平台日志格式变化，应保留等价字段，不能删除关键判定信息；
- 任何新规则不得覆盖本归档的冻结规则；需新增版本。
