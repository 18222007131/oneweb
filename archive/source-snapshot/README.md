# ClodStorageAgent

基于 **LangGraph JS（TypeScript + Node.js）** 与 **DeepSeek** 的冷库多智能体命令行项目。当前只实现命令行交互、账号权限和 Agent 流转，不包含前端页面、GenUI 或数据库。

## 一、目录结构

```text
ClodStorageAgent/
├── .env                  # 已存在，请勿提交到仓库
├── accounts.json         # 账号身份、上次登录账号
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── main.ts               # LangGraph 图、CLI 主循环、账号会话、PLC 定时采样器
    ├── state.ts              # State、DeepSeek 客户端、日志和公共工具
    ├── account-store.ts      # 本地JSON账号、自动登录、权限判断
    ├── equipment-registry.ts # 库房/机组状态、COP警报、设备异常警报
    ├── plc-monitor.ts        # PLC历史统计、5天均值、2小时长期异常检测
    ├── resource-scheduler.ts # 全局资源队列：PLC / LLM / 台账
    ├── console-gate.ts       # 控制台日志闸门：输入期间缓冲后台日志
    └── agents/
        ├── master.ts         # 管理员（权限、消息来源、警报和报告输出）
        ├── scheduler.ts      # 调度员（组单、台账、库房状态检查）
        ├── xiaoke.ts         # 小柯（PLC采样 + 两套COP + 分摊/质检送审）
        └── reviewer.ts       # 质检员（入库单据 + COP三项质检）
```

## 二、运行环境

- Node.js >= 20
- npm
- 项目根目录已有 `.env`，需要包含：

```dotenv
DEEPSEEK_API_KEY=你的_deepseek_api_key
# 可选，默认 https://api.deepseek.com
DEEPSEEK_BASE_URL=https://api.deepseek.com
# 可选，默认 deepseek-chat
DEEPSEEK_MODEL=deepseek-chat
```

可选业务参数：

```dotenv
COLD_ROOM_CAPACITY_TONS=2000
# 默认5分钟一次，最小3000ms仅用于调试
PLC_POLL_INTERVAL_MS=300000

# PLC长期异常判定：默认连续2小时、24个采样点
PLC_LONG_TERM_WINDOW_MINUTES=120
PLC_LONG_TERM_MIN_SAMPLES=24

# 三类资源的任务超时（毫秒）
PLC_TASK_TIMEOUT_MS=5000
LLM_TASK_TIMEOUT_MS=60000
LEDGER_TASK_TIMEOUT_MS=5000

# 演示模式：审核驳回优先整改重提，兜底上限6次；正式模式默认上限3次
# COLD_STORAGE_DEMO_MODE=1
```

## 三、安装与启动

```bash
cd ClodStorageAgent
npm install
npm run dev
```

也可以使用：

```bash
npm start
# 仅类型检查
npm run typecheck
```

## 四、命令行菜单

库内账号显示完整业务菜单：

```text
1. 提交入库预约（果品/吨位/入库时间/贮藏天数）
2. 录入到货入库单
3. 查看历史入库台账
4. 请求小柯COP核算报告（自动判断正式/预估）
5. 切换账号
6. 退出登录
8. 解除核算异常警报
9. 解除设备异常标记
0. 退出
```

库外账号显示预约菜单：

```text
1. 填写预约表单并提交入库预约（果品/吨位/入库时间/贮藏天数）
3. 查看我的预约单
5. 切换账号
6. 退出登录
0. 退出
```

注意：

- **库内、库外账号都可以提交入库预约**，填写果品、吨位、入库时间、贮藏天数，作为生成预约单的依据。
- **预约表单不再收集预约果品温度**；Q1由小柯使用该果品推荐贮藏温区的呼吸强度查表计算。
- **菜单1预约时用户只填果品、吨位、预约时间、贮藏天数，不填库房。** 提交后由 master 派发 scheduler，scheduler 经 master 向小柯获取全部库房库存/状态，再按果品温湿度、吨位、机组状态和占用状态筛选；master 把全部满足条件的候选库房展示给用户，用户只能从候选列表中选择。
- 库房编号规范为“区域号+编号”：`A1` = A区1号冷库，`B2` = B区2号冷库。
- 机组异常或库房状态为占用的库房绝不进入候选列表；已有预约审核通过后，所选库房会被标记为占用。
- **PLC 采样由后台定时器自动执行**，默认每5分钟向 PLC 请求功率、压力、温度，计算 W 和 COP 后仅保存历史采样，不生成报告。
- **菜单 4 是库内人员COP请求入口**；库内发起时不需要手动录入果品、吨位或温度，小柯自动调取已通过质检的预约单/入库单。
- 原来的菜单7预约预估不再单独显示，已合并为菜单4的自动兜底。
- 发起菜单 4 后，master 先要求选择COP类型：
  - `1` 单库房COP：必须输入库房编号（区域号+编号，如A区1号为A1），该库房Q/W直接计算。
  - `2` 机组分摊等效COP：一机拖多库房时按各库房热负荷比例分摊总功耗，不输入库房编号。
- 选择类型后，小柯先向master申请入库单：
  - 有入库单：进入正式COP核算。
  - 没有入库单：继续向master申请预约单，自动进入预约阶段COP预估。
  - 两者都没有：终止并生成核算异常警报。
- **只有正式核算**才会请求额外的果品中心温度；预约预估不询问中心温度。
- 单据调取失败会终止核算并生成警报，原因写明：
  - 单据不存在
  - 单据未通过质检核对
  - 中转通讯异常
  - 单据缺少果品/吨位/温度关键字段
- 单库房COP：COP = 该库房Q / W；机组分摊等效COP：Wi = W总 × Qi/Q总，COPi = Qi/Wi。
- 单库房COP与机组分摊等效COP分开存储，质检历史均值也分开比对，不能混用。
- 预约时不再录入果品温度；Q1呼吸热按果品推荐贮藏温区中间温度查表。正式核算才要求果品中心实测温度。
- 库外账号手动输入 2 或 4 会被直接拦截并提示权限不足；库内账号可以使用菜单1提交预约。Master 内部还会再做一次权限校验，防止绕过菜单。
- 总库容为 **2000 吨**。用户输入的预约吨位或实际到货吨位超过上限时，CLI 会直接提示最大输入容量并要求重新输入；Master 还会在派发前再次校验，防止无效输入继续流转。
- 预约入库时间使用**电脑本地时间**校验。输入时间早于当前本机时间时，CLI 会直接提示时间错误并要求重新输入；Master 和 reviewer 也会再次校验。
- **每个用户任务返回结果后，CLI 会自动重新打印完整菜单和编号，再等待下一次选择**，不需要输入任意文字来唤回菜单。
- 后台任务完成时，如果用户正在菜单输入阶段，后台日志会继续留在缓冲区，不会覆盖菜单或打断输入；下一次菜单打印发生在安全的输入完成点。

## 五、账号与权限

账号身份保存在项目根目录 [accounts.json](accounts.json)，格式如下：

```json
{
  "accounts": {
    "admin": "internal",
    "warehouse01": "internal"
  },
  "lastLoggedIn": "admin"
}
```

规则：

- `internal` 为库内账号，必须提前写入 JSON。
- `external` 为库外账号；未登记的账号第一次登录时默认按库外账号处理，并写回 JSON。
- 初始化内置库内账号：`admin`、`warehouse01`。
- 初始化 `lastLoggedIn` 为 `admin`，启动时自动登录。
- 登录时只需输入账号名；这是本地演示身份，不包含密码认证。
- 菜单 **5** 切换账号：输入新的账号名后立即切换，并更新 `lastLoggedIn`。
- 菜单 **6** 退出登录：清空 `lastLoggedIn`，回到登录提示；下次启动不会自动登录。
- 重启进程时读取 `lastLoggedIn` 自动登录；若为空则要求登录。

权限矩阵：

| 功能 | 库内账号 | 库外账号 |
|---|---|---|
| 提交入库预约/填写预约字段（1） | 可用 | 可用 |
| 录入到货入库单（2） | 可用 | 隐藏并拦截 |
| 查看历史入库台账（3） | 全部台账 | 仅自己的预约单 |
| 请求小柯COP报告（4） | 可用 | 隐藏并拦截 |
| 切换账号（5） | 可用 | 可用 |
| 退出登录（6） | 可用 | 可用 |
| 解除核算异常警报（8） | 可用 | 隐藏并拦截 |
| 解除设备异常标记（9） | 可用 | 隐藏并拦截 |

所有新生成的入库预约单、到货入库单和 COP 报告都会写入 `createdBy` 创建账号字段。库外账号查询预约单时，只返回 `docType=appointment` 且 `createdBy` 等于当前账号的单据。

## 六、两条链路

### 链路 A：入库预约 / 到货入库

```text
用户填写预约信息（果品/吨位/时间/贮藏天数，不含库房和果品温度）
  -> master
  -> scheduler 接收预约任务
  -> scheduler → master → xiaoke：查询全部库房库存/占用/机组状态
  -> xiaoke → master → scheduler：返回库房库存
  -> scheduler 按果品温湿度、吨位容量、机组正常、库房未占用筛选
  -> scheduler → master：返回全部满足条件的候选库房
  -> master 展示候选库房
  -> 用户从候选中选择
  -> scheduler 组装预约单据（带所选库房）
  -> reviewer 调用DeepSeek做合规核验，返回 passed 和失败原因
  -> scheduler 接收审核结果
       ├─ 通过：仅写入入库台账；所选库房标记为占用，结束
       ├─ 不通过：scheduler读取驳回原因 → 向master确认整改指引
       │           → 针对性修改单据参数/表述并记录修订版本
       │           → 重新送reviewer（禁止原样重提）
       └─ 整改后仍不通过：正式模式3次兜底/演示模式6次兜底后终止，不写台账
  -> master 统一输出
```

- 库内、库外账号都可以填写预约表单（果品/吨位/时间/贮藏天数）并生成预约单；库内账号同时负责到货入库。
- 该链路没有 scheduler -> xiaoke 的直接边；库房库存查询经 master 中转。
- 用户不能预先指定库房，只能从 master 展示的候选库房中选择。
- 机组异常（整台机组所有库房）和已占用库房不会进入候选。
- 审核通过写入台账时同时标记 `reviewPassed=true`、`reviewedAt`、`reviewedBy`；COP核算只会调取已通过质检核对的单据。
- 入库存档流程中不出现冷负荷、预冷、功率、COP或碳排结果。

#### 链路 A2：到货偏差协商重规划

到货单组装完成后，先由小柯做偏差检查，再进入reviewer：

```text
原始预约：果品、预约吨位、库房、生成Q1 q_resp时使用的条件温度
实际到货：实际吨位、实际货温

吨位偏差% = |实际吨位 - 预约吨位| / 预约吨位 × 100
只有吨位偏差 > 5% 才触发重规划
```

- 到货货温不再参与偏差触发判断，也不计算货温偏差百分比。
- q_resp条件温度仍然正常查询、记录和展示，用于追溯复盘；只是不参与本分支触发。
- q_resp条件温度与PLC采样参数一起写入 `thermalPlcHistory` 历史记录。
- 预约预估COP完成后，会把 `qRespConditionTempC`、`qRespConditionSource` 写回对应预约单。
- 日志打印：原始预约参数、q_resp条件温度、实际货温、预约/实际吨位、吨位偏差%；不据此走温度重规划。

偏差>5%时：

```text
小柯 → master：上报偏差
master 展示：原始预约参数、实际到货参数、偏差百分比
库内人员选择：① 增加库房 / ② 更换库房
master → scheduler：传递选择
scheduler 重新规划：
  增加库房：保留原库房，新增可用库房，生成多库房分摊的新入库单
  更换库房：选择新的可用库房，释放原库房，同步更新预约单库房
scheduler → 小柯：新入库单（新单号 RK...-R1，带入原单号/偏差/选择/新方案）
小柯 → scheduler：接收新单，继续后续审核
scheduler → reviewer → 入库台账
```

- 此流程属于贮藏方案重新规划，**不进入普通单据整改重试**。
- 其他普通参数被reviewer驳回时，继续走“读取驳回原因→master确认→修改单据→重提”的整改规则。
- 增加库房时，新单 `roomAllocations` 记录原库房和新增库房各自分摊吨位，审核通过后这些库房都标记占用。
- 更换库房时，新单记录原库房和更换后库房，审核通过后释放原库房、占用新库房，并同步预约单库房。
- 全程留痕：原始预约、q_resp条件温度、实际到货货温、预约/实际吨位、吨位偏差%、库内人员选择、调度员新方案、新入库单编号。
- 偏差未超过5%时直接转reviewer，不打扰库内人员。

#### 链路 A3：库房前置硬筛选与入库超时

**库房前置硬筛选**

Scheduler在把库房交给master前必须完整校验：

1. 果品适配品类（`suitableFruits`）；
2. 库房温区覆盖果品推荐贮藏温区；
3. 贮藏湿度匹配；
4. 可用库容≥预约吨位；
5. 机组正常；
6. 库房未占用。

- 只有全部合格库房才会进入候选列表；未合格库房绝不进入reviewer或入库流程。
- Scheduler预选后、交给管理员/用户前，先由reviewer做一次**前置快速合规核验**（品类/温区/湿度/库容/机组/占用）。
  - 核验通过：才交给master展示给用户选择。
  - 核验不通过：直接打回scheduler重新选库房，不进入用户选择，也不进入入库单整改重试。
  - scheduler会排除已淘汰库房，重新预选并再次前置核验，直到通过或无可用库房。
- 匹配成功必须打印：库房编号、库房温区、可用库容、匹配合规说明、可正常入库、前置Reviewer核验通过。
- 预选日志逐个打印：比对库房、品类/温区/湿度/库容/机组/占用、淘汰原因、最终候选及核验结果。
- 全部库房不满足时打印：
  - `【暂时没有满足本次预约条件的合格库房】`
  - `暂无匹配库房，本次预约无法分配贮藏位置`
  - 已上报管理员；单据直接终止，不进入reviewer。
- 前置核验不通过与后续“普通单据字段笔误整改”是两条边界：前者回退scheduler重选库房；后者才走Agent整改重提。
- 任务组装时，预约单/到货单必须携带 `tempZone`、`humidity`、`temperatureRequirement`、`humidityRequirement`、`tempMinC`、`tempMaxC`、`fruitSpec`。
- reviewer审核时，payload额外携带 `builtInFruitSpecs`（杨梅/柚子/苹果内置温湿度参数）和 `documentFruitSpec`，本地规则与LLM都按内置参数校验，不得再报“缺少内置温湿度参数”。
- 到货偏差改为仅按吨位触发后，scheduler库房预选、前置核验和reviewer入库温湿度匹配逻辑不变。

**入库超时**

- 到货处理时系统自动比较：实际入库时间（当前本地时间）> 预约单预约入库时间。
- 超时旧预约单禁止继续入库，不组装到货单、不进入reviewer。
- master询问库内人员：是否重新发起新预约。
  - 选择“是”：旧预约作废（状态`expired`/已失效、释放原库房占用），完整重跑预约→库房筛选→分配库房→打印结果。
  - 选择“否”：旧预约作废，流程结束。
- 到货单记录 `actualInboundAt`；超时预约记录 `expiredAt`、`expiredReason`。

### 链路 B：小柯 COP 核算

#### B1. 后台 PLC 定时采样

```text
PLC定时器（默认5分钟）
  -> xiaoke 向PLC请求功率、压力、温度等参数
  -> 计算 W 和 COP
  -> 保存到 State.copRecords 历史序列
  -> 不经过master、不查询台账、不生成COP报告
```

用途：

- 为COP质检提供5天历史均值和偏离比对。
- 供长期异常监测：连续2小时异常时标记设备异常。

#### B2. 两种COP口径

发起菜单4后，先选择COP口径：

```text
1. 单库房COP：必须输入库房编号，区域号+编号，如A区1号为A1、B区2号为B2
2. 机组分摊等效COP：一机拖多库房时，按热负荷比例分摊机组总功耗
```

**单库房COP**

```text
COP = 该库房Q / W
```

- 直接使用所选库房的Q1或Q2和本次PLC电功率W，不做机组分摊。
- 报告标记【单库房COP】。

**机组分摊等效COP**

```text
Q总 = 该机组当前全部库房热负荷之和（每次动态求取）
Wi = W总 × Qi / Q总
COPi = Qi / Wi
```

- 先按各库房热负荷比例分摊机组总功率，再计算COPi。
- 报告标记【机组分摊等效COP】，同时列出各库房Qi、占比、Wi、COPi。

**热物性查表**

- `q_resp`：按【果品+温度】查表，温度线性插值；表中单位W/t，运行时÷1000换算W/kg。
- `c`：按【果品+冻结点】选择高于冰点/低于冰点档位，档内定值，不做温度插值。
- 初始内置杨梅、柚子、苹果，数值为USDA Handbook 66/冷冻冷藏手册附表的参考占位值，可替换。
- `src/thermal-properties.ts` 集中维护，不允许在计算函数里写死常数。

**预约阶段预估（Q1）**

```text
读取预约果品、吨位
重量换算 kg
按该果品推荐贮藏温区中间温度线性插值 q_resp
Q1 = m × q_resp
W 从PLC取得
COP = Q1 / W
标记【预约预估值】
```

**入库后正式核算（Q2）**

```text
读取果品实际中心温度、库房当前温度、实际吨位
按果品+中心温度查 q_resp，并按冻结点选c档
ΔT = 中心温度 - 库房温度
Q2显热平均功率 = m·c·ΔT / 预冷时长
Q2呼吸热 = m·q_resp
Q2实际热负荷 = Q2显热平均功率 + Q2呼吸热
COP = Q2 / W（单库房）或按分摊后的Wi计算（机组分摊）
标记【正式核算值】
```

- 单库房COP和机组分摊等效COP分别存储。
- COP质检的5天历史均值按相同核算方式、相同COP口径（单库房还按相同库房）比对，不能混用。
- 核算成功输出：COP类型、库房编号（如有）、Q1、Q2、W、最终COP，以及q_resp/c的查表来源和插值/档位说明。

#### B3. COP请求取数顺序与消息来源

```text
用户菜单4
  -> master 要求选择COP口径/库房编号（区域号+编号）
  -> master 通知 xiaoke
  -> xiaoke → master：申请获取入库单
  -> master → scheduler：查询到货单
  -> scheduler → master：返回到货单

  有入库单：
    -> master 要求用户补充果品中心温度（只有正式核算才要求）
    -> xiaoke 实时向PLC取数
    -> xiaoke 正式核算 -> reviewer 质检
    -> 通过后 xiaoke → master 输出报告

  没有入库单：
    -> master → scheduler：申请预约单
    -> scheduler → master：返回预约单
    -> master → xiaoke：转交预约单
    -> xiaoke 实时向PLC取数 -> 预约预估 -> reviewer 质检
    -> 通过后 xiaoke → master 输出报告

  两者都没有：
    -> 终止COP核算，生成核算异常警报并写明“单据不存在/未通过质检核对/中转通讯异常/缺少关键字段”等具体原因
```

- 小柯不直接向 scheduler 取单；所有跨Agent请求都经 master 中转。
- master 转发的消息会标注来源，例如【消息来源：小柯】、【消息来源：scheduler】。
- 只有正式核算路径才出现“小柯正式核算需要果品中心温度”的提示；预约预估不会询问中心温度。
- 取数后立即释放PLC资源；等待reviewer和制作报告期间，后台5分钟PLC采样和存储继续独立运行。

#### B4. 单次COP质检与核算异常警报

reviewer 对每次COP结果做三项检查：

1. 是否异常值（非有效数值、统计离群）。
2. 是否超出预设边界（正式核算1.8~4.2；预约预估0.01~10）。
3. 相对相同核算方式、相同COP口径（单库房还按相同库房）5天历史均值偏离是否超过5%。

- 最多重试3轮；每轮重新取PLC并重算。
- 质检通过后才制作【预约预估值】或【正式核算值】报告。
- 3轮重试仍不通过：终止本次核算，不生成报告，master生成【核算异常警报】。
- **单据缺失、单据未通过质检核对、中转通讯异常、单据缺少果品/吨位/温度关键字段、q_resp超出查表范围、热物性表找不到果品**等情况，立即终止核算，不生成报告，直接生成【核算异常警报】，警报中写明具体失败原因。
- 警报不会自动清除；必须库内人员通过菜单8手动输入“确认解除”完成解除，之后才能重新发起COP请求。
- 单次COP警报**不标记设备故障，不阻塞到货入库，也不禁止新预约**。

#### B5. 机组/传感器长期异常

- PLC每5分钟采样一次；默认连续2小时（24个5分钟采样）持续出现越界/异常值/大幅偏离历史均值，才判定为设备异常。
- 单次短时扰动或被正常采样打断的异常不会被长期判定。
- 设备异常后：
  - 小柯将库房/机组标记【设备异常】。
  - master 推送设备警报，包含换库建议、建议换库原因、排查建议和受影响在库货品。
  - scheduler 处理新预约前先通过 master 代向小柯查询全部库房库存/状态，再按果品筛选；master 会标注“小柯库房状态”和“scheduler调度请求”来源。机组异常的库房及其同机组库房禁止分配新预约。
  - 已入库存货品不会自动转移，需要库内人员按建议落实换库/排查。
- 长期异常与单次COP异常是两套独立判断。
- 库内人员排查完成后通过菜单9手动确认解除设备异常，scheduler 才重新开放该库房预约。

## 七、角色职责

| 角色 | 职责 |
|---|---|
| Master 管理员 | 用户入口、账号权限校验、COP类型/库房编号校验、所有跨Agent消息中转并标注来源、设备/核算警报推送、保存并输出COP报告 |
| Scheduler 调度员 | 组装单据、送reviewer；驳回后读取原因、向master确认整改指引、针对性修改并带修订记录重提；到货偏差时按增加/更换库房选择重新规划并生成新入库单；到货时先做预约超时校验；通过后写台账；按品类/温区/湿度/吨位/机组/占用完整前置筛选候选库房，前置核验不通过则重选，全部不合格时直接终止；审核通过后标记库房占用 |
| Reviewer 质检员 | 对候选库房做前置快速核验（品类/温区/湿度/库容/机组/占用），不通过直接打回scheduler；对入库单据校验果品内置温湿度与单据字段一致；对COP核算结果做异常值/预设边界/5天历史偏离三项质检 |
| Xiaoke 小柯 | 5分钟PLC采样和历史存储；维护全部库房库存/占用/机组状态；到货货温/吨位偏差检查并上报；自动调取已通过质检的预约/入库单；果品+温度q_resp线性插值、冻结点c档位；Q1/Q2计算；单库房COP/机组分摊等效COP；长期设备异常监测；按指令生成报告 |

## 八、全局资源调度

`src/resource-scheduler.ts` 提供全局 `resourceScheduler`，资源池完全独立：

| 资源 | 使用者 | 队列行为 |
|---|---|---|
| `plc` | xiaoke 后台PLC采样 | 后台优先级，串行访问PLC |
| `llm` | reviewer DeepSeek 合规审核 | 质检员审核优先级，串行调用大模型 |
| `ledger` | scheduler 台账读写、reviewer 台账校验 | 按发起任务优先级排队，串行读写 |

调度规则：

1. 同一资源的任务严格串行，正在运行的任务不会被打断。
2. 不同资源的任务可以并行。例如 reviewer 在等待 DeepSeek 时，PLC 后台采样可以同时进行。
3. 队列优先级为：`用户交互任务 > 质检员审核任务 > 小柯后台自动任务`。
4. 同优先级严格 FIFO；后台任务不能插到用户或审核任务前面。
5. 每个资源任务都有独立超时。超时后立即判定该任务失败、记录 `[task-scheduler] 超时...`、释放资源并调度下一个任务，不会阻塞整组。
6. 超时任务的调用方会返回失败提示：reviewer 审核失败、台账查询/写入失败、PLC采样失败。
7. 用户交互链路和PLC后台链路使用不同的 LangGraph 线程；PLC采样完成后只更新共享的最新采样快照，下一次用户请求再带入用户State。

控制台保护：

- 任务**排队等待期间不输出任何日志**，只有真正获得资源、开始执行时才输出开始日志。
- 用户从选择菜单到填写完所有字段的完整输入期间，`console-gate.ts` 会缓冲后台任务和资源调度器日志。
- 输入完成后才统一 flush，因此后台任务不会清屏、不会插入字符、不会打断正在输入的命令行。
- 输入期间正在执行的后台任务可以继续执行，但它的日志会暂存到输入结束。
- 用户任务结束后，主循环会自动重新渲染菜单；后台任务不会主动抢占当前菜单输入行。

调度日志示例：

```text
[task-scheduler] 开始 resource=llm priority=reviewer(质检员审核) task=reviewer-deepseek-compliance timeout=60000ms
[task-scheduler] 完成 resource=llm task=reviewer-deepseek-compliance duration=310ms queueWait=0ms
[task-scheduler] 超时 资源任务超时：llm/reviewer-deepseek-compliance 超过 150ms，本次任务失败，资源已释放。
[task-scheduler] 开始 resource=llm priority=reviewer(质检员审核) task=reviewer-deepseek-compliance timeout=150ms
```

任务入队时不打印日志；上述开始日志仅在其真正轮到执行时出现。

## 九、State 字段

`src/state.ts` 使用 LangGraph `Annotation.Root` 定义状态。需求指定字段保留：

| 字段 | 类型 | 含义 |
|---|---|---|
| `userInput` | `string` | 当前用户输入 |
| `nextAgent` | `"" \| "调度器" \| "小珂"` | 面向业务的 Agent 指向 |
| `taskContent` | `string` | Master 任务说明 |
| `结果` | `string` | 当前链路结果 |
| `reviewPass` | `boolean` | reviewer 审核是否通过 |
| `reviewReason` | `string` | reviewer 审核不通过的具体原因 |
| `rejectTarget` | `"" \| "调度器" \| "小珂"` | 保留字段 |
| `retryCount` | `number` | scheduler 管理的整改/重提轮次 |
| `记录` | `Array<Record<string, any>>` | 已审核通过的入库单据台账 |

关键辅助字段：

- `account`：当前登录账号
- `accountType`：`internal` / `external`
- `flowType`：`user` / `plc`
- `phase`：链路阶段
- `routeTo`：LangGraph 条件边实际路由目标
- `pendingDocument`：送审中的暂存单据，含 `documentRevision`、`rectificationNotes`、`reviewReasonAddressed` 等整改痕迹
- `pendingUpdates`：通过后需要同步更新的关联预约单
- `rectificationGuidance`：master确认的针对性整改指引
- `arrivalDeviation`：到货偏差检查详情（原始预约、q_resp条件温度、实际到货、吨位偏差%、阈值；温度仅留痕）
- `thermalPlcHistory`：q_resp条件温度与PLC采样参数合并保存的历史记录，供回溯、日志、复盘
- 预约单上的 `qRespConditionTempC`/`qRespConditionSource`：预估COP生成q_resp时实际使用的条件温度及来源，仅留痕不参与触发
- `arrivalReplanChoice` / `arrivalReplanRevision`：到货重规划选择（增加/更换库房）和修订轮次
- `ledgerDocuments`：master 中转的已通过质检台账数据
- `copInboundDiagnostic` / `copAppointmentDiagnostic`：COP取单失败的具体诊断（单据不存在/未通过质检核对等）
- `roomInventory`：小柯返回的全部库房库存/占用/机组状态
- `roomCandidates`：scheduler筛选、reviewer前置核验通过后，master展示给用户的可预约库房
- `roomPrecheckAttempt` / `roomPrecheckRejectedRooms` / `roomPrecheckFailures`：前置核验轮次、已淘汰库房和淘汰原因
- `copRecords`：PLC定时采样与W/COP历史
- `copPlcSnapshot`：菜单4本次实时向PLC调取的参数
- `copCalculation`：小柯提交reviewer审核的COP核算结果，含COP类型、库房分摊、公式结果
- `copReportMode`：`estimate` / `formal`
- `copScope`：`single` / `allocated`
- `copRoomCode`：单库房COP的目标库房编号
- `copRetryCount`：COP质检重试轮数
- `reportPayload`：xiaoke质检通过后回传的COP报告载荷
- `reportRecords`：master保存的COP报告，含 reportMode / copScope / roomCode / Q1 / Q2 / W / COP / 热物性来源 / rooms
- `latestReportText`：最近一次COP报告文本

入库台账、PLC采样和COP报告都保存在 LangGraph State（`MemorySaver`）中，进程退出后释放。台账单据中的 `createdBy` 记录创建账号，`roomCode`/`roomName` 记录库房编号和区域名称（如 `A1` / `A区1号冷库`），并通过 `reviewPassed`、`reviewedAt`、`reviewedBy` 标记质检核对结果；COP只调取 `reviewPassed=true` 的单据。到货单记录 `actualInboundAt`；超时预约单记录 `expiredAt`、`expiredReason`。设备状态、库房占用和两类警报保存在 `equipment-registry.ts` 的进程内共享登记处，必须手动解除。

库房库存登记示例：

| 库房 | 区域号+编号 | 机组 | 温区 | 容量 | 适配品类 | 初始状态 |
|---|---|---|---|---|---|---|
| A区1号冷库 | A1 | 1号机组 | 0.5~2°C | 400t | 杨梅 | 可用 |
| A区2号冷库 | A2 | 1号机组 | 0.5~2°C | 400t | 杨梅 | 可用 |
| B区1号冷库 | B1 | 2号机组 | 5~10°C | 300t | 柚子 | 可用 |
| B区2号冷库 | B2 | 2号机组 | 5~10°C | 300t | 柚子 | 占用（示例） |
| C区1号冷库 | C1 | 3号机组 | -1~0°C | 300t | 苹果 | 可用 |
| C区2号冷库 | C2 | 3号机组 | -1~0°C | 300t | 苹果 | 可用 |

- 总容量 2000 吨。
- 机组异常会同时屏蔽该机组下所有库房。
- 已占用库房不会进入候选列表；预约审核通过后自动标记占用。

## 十、质检说明

- Reviewer 对预约单检查果品、温区、湿度、吨位、预约时间、计划天数和库容时段。
- 对到货单检查关联预约单是否存在且可入库、实际吨位和货温。
- 所有入库单据都通过 `callDeepSeekJson` 发送给 DeepSeek 做合规判断；本地硬规则只作为兜底，防止 LLM 误放行。
- 菜单4时，reviewer 还会审核小柯提交的COP核算结果：
  - 检查COP口径（单库房/机组分摊等效）、库房编号、分摊数据、Q1/Q2、W、热物性来源和公式结果。
  - 检查异常值、预设边界、相同口径（单库房还按相同库房）5天历史均值偏离是否超过5%。
  - 单库房与机组分摊等效COP、预估与正式核算的历史序列分别比对，不能混用。
- 审核不通过时返回具体原因；COP质检最多重试3轮，仍不通过则终止并触发核算异常警报。
- 入库单据驳回后不原样重提：
  1. scheduler 读取 `reviewReason`；
  2. 向 master 申请整改指引（按驳回原因核对参数/表述）；
  3. 修改单据字段、补全说明，写入 `documentRevision`、`rectificationCount`、`rectificationNotes`、`reviewReasonAddressed`；
  4. 重新送 reviewer，reviewer可看到修订版本和整改说明。
- 正式模式兜底上限3次整改，演示模式（`COLD_STORAGE_DEMO_MODE=1`）兜底上限6次，优先争取整改通过。
- Reviewer 的 State 输出包含 `reviewPass`、`reviewReason` 和必要的路由信息，不返回方案、台账变更或计算结果。

## 十一、PLC 与核算说明

当前没有接入真实 PLC，`xiaoke.ts` 中的 `requestPlcSample()` / `pollPlc()` 是模拟 PLC 数据源，并通过全局 `plc` 队列串行访问。真实项目可将其替换为 Modbus TCP、OPC UA 或 PLC 网关读取。

默认每5分钟采样一次，历史序列最多保留2000条，满足5天均值计算。每次采样记录：

- 供温、回温、库房当前温度
- 吸气压力、排气压力
- 功率 W、COP
- 冷却能力 W
- 采样时间、库房/机组编号

用途：

1. 为COP质检提供同口径、同库房5天历史均值。
2. 长期监测：默认连续2小时（24个5分钟采样）异常时触发【设备异常】。

管理员通过菜单4选择单库房COP或机组分摊等效COP；小柯先申请入库单，有入库单走正式核算（此时才要求果品中心温度），没有入库单自动转预约预估（不要求中心温度）。核算结果经reviewer按三项规则审核通过后再制作报告。定时PLC采样与存储在整个过程中继续运行。

结果仅供工程演示，不替代计量账单或碳核查。

## 十二、热物性、Q1/Q2与输出规则

热物性集中维护在 `src/thermal-properties.ts`：`THERMAL_PROPERTIES` 可替换；计算函数不得写死q_resp/c。

| 项目 | 规则 |
|---|---|
| q_resp | 按果品+温度查找W/t表，线性插值，运行时÷1000换算W/kg |
| c | 按果品+冻结点判断，高于冰点/低于冰点两档，档内定值，不插值 |
| 数据来源 | USDA Handbook 66 / 冷库与食品冷冻冷藏手册附表（参考占位值，可替换） |
| 内置果品 | 杨梅、柚子、苹果 |

- `Q1 = m(kg) × q_resp(果品推荐贮藏温区中间温度)`，用于预约预估COP；预约表单不采集果品温度。
- `Q2 = m·c·ΔT`折算的显热平均功率 + `m × q_resp(实际中心温度)`呼吸热，用于正式COP。
- 核算成功后的报告固定输出：COP类型、库房编号（如有）、Q1、Q2、W、最终COP、q_resp/c查表来源和插值/冻结点档位说明。
- 单据缺失或热物性查表失败时：终止核算、不生成报告、生成核算异常警报；菜单8手动解除。警报不阻塞到货入库和新预约。
