# 判定规则、边界与数据契约

- 版本：`v1.0.0-demo-baseline`
- 所有规则编号可被回归用例引用。
- 标记【最终】的规则是平台验收标准；标记【已废止】的规则只用于避免回归误用。

## 1. 规则优先级

从高到低：

1. 账号/权限；
2. 角色/流程前置条件（登录、任务类型、库房编号、COP 口径）；
3. 入库超时；
4. 库房硬预选；
5. reviewer 前置快速核验；
6. 用户选择与单据审核；
7. 到货偏差（仅吨位）；
8. 普通单据整改；
9. COP 取数/核算/质检；
10. 告警与人工解除。

下层规则不得绕过上层规则。例如：

- 未通过库房前置核验的库房，不得因为“reviewer 后面可能通过”而展示给用户；
- 超时预约不得因为“用户已经填了到货吨位”而继续入库；
- 温度差异不得绕过“仅吨位触发”的到货偏差边界。

## 2. 库房预选与前置核验

### R-ROOM-01【最终】硬性校验

```text
合格 =
  品类适配（suitableFruits 包含果品）
  AND 库房温区覆盖果品推荐温区
  AND |库房湿度 - 果品湿度| <= 5（百分点）
  AND 可用库容 >= 预约吨位
  AND 机组正常
  AND 库房可预约且未占用
```

- 任一不满足即淘汰。
- 只有全部满足的库房进入前置 reviewer 核验。
- 淘汰原因必须写日志。

### R-ROOM-02【最终】前置核验时机

```text
scheduler 预选
  -> reviewer 前置快速核验
  -> 通过后才允许 master 展示给用户
```

禁止：

- 先把未核验库房给用户选；
- 用户选完再让 reviewer 报温湿度不匹配；
- 前置失败进入普通单据整改。

### R-ROOM-03【最终】前置失败回退

- reviewer 前置不通过 → 返回 scheduler；
- scheduler 把失败库房加入 `roomPrecheckRejectedRooms`；
- scheduler 重新预选，排除已淘汰库房；
- 再次前置核验；
- 若全部淘汰 → 进入 R-ROOM-04。

### R-ROOM-04【最终】无合格库房

输出固定提示：

```text
【暂时没有满足本次预约条件的合格库房】
暂无匹配库房，本次预约无法分配贮藏位置
已上报管理员；本次单据直接终止，不进入reviewer审核
```

- 不创建预约单；
- 不进入 reviewer；
- 不写台账；
- 不进入用户选择。

### R-ROOM-05【最终】库房占用

- 预约审核通过：所选库房标记 `occupied`。
- 到货重规划：
  - 增加库房：原库房继续占用，新库房增加占用；
  - 更换库房：释放原库房，占用新库房。
- 释放只由明确的业务动作触发，不得因查询/失败自动释放。

## 3. 到货偏差

### R-DEV-01【最终】只按吨位触发

```text
tonnageDeviationPct =
  |actualTonnage - appointmentTonnage| / appointmentTonnage * 100

overThreshold = tonnageDeviationPct > 5
```

- 温度不作为触发条件。
- 不计算温度偏差百分比。
- 温度差异再大，只要吨位未超5%，不进入重规划。

### R-DEV-02【最终】温度仍须记录

- q_resp 条件温度仍然查询；
- 到货货温仍然记录；
- 两者都写入日志；
- 两者都写入 `thermalPlcHistory`；
- 不因取消温度触发而丢弃参数。

### R-DEV-03【最终】触发后的分支

- 小柯上报 Master；
- Master 让库内人员选择：
  - `add`：增加库房；
  - `change`：更换库房；
- Scheduler 重新规划，生成新入库单，新单号带 `-R<n>`；
- 新单返回小柯，继续审核；
- 不消耗普通整改次数。

### R-DEV-04【最终】重规划留痕

必须记录：

- 原始预约单、果品、预约吨位、原库房；
- q_resp 条件温度及来源；
- 实际吨位、实际货温；
- 吨位偏差百分比；
- 用户选择；
- 新方案（原/新增/更换库房、分摊吨位）；
- 新入库单号；
- 重规划时间。

### R-DEV-05【最终】边界

| 场景 | 处理 |
|---|---|
| 吨位偏差 >5% | 增加/更换库房重规划 |
| 温度差异任意大、吨位≤5% | 不重规划，正常审核 |
| 重规划后新单字段笔误 | 普通整改 |
| 用户不选择增加/更换 | 流程等待，不得擅自继续 |

## 4. 入库超时

### R-TIM-01【最终】判定

```text
actualInboundAt = 系统处理到货时的本地时间
expired = actualInboundAt > appointment.scheduledAt
```

- 超时后禁止直接使用旧预约单。
- 不组装到货单。
- 不进入 reviewer。
- 不写台账。

### R-TIM-02【最终】用户选择

```text
是 -> 旧预约 expired/已失效，释放库房
    -> 完整重跑预约→库房预选→前置核验→用户选择→审核→台账
否 -> 旧预约 expired/已失效，释放库房，流程结束
```

- 旧单作废必须写 `expiredAt`、`expiredReason`。
- 重新预约是新的完整流程，不是补字段重提。

## 5. 单据审核与整改

### R-REV-01【最终】reviewer 校验

预约单：

- 果品属于内置三类；
- `tempZone`/`temperatureRequirement` 与内置一致；
- `humidity`/`humidityRequirement` 与内置一致；
- 吨位 >0 且 ≤2000t；
- 预约时间晚于当前本机时间；
- 贮藏天数为正整数；
- 不得出现到货货温；
- 库容时段不冲突。

到货单：

- 关联预约存在且状态 `booked`；
- 果品、温区、湿度与关联预约/内置一致；
- 吨位 >0 且 ≤2000t；
- 货温 -5~45°C。

### R-REV-02【最终】内置参数传递

- 单据必须带 `tempZone`、`humidity`、`temperatureRequirement`、`humidityRequirement`、`tempMinC`、`tempMaxC`、`fruitSpec`。
- reviewer payload 必须带 `builtInFruitSpecs` 和 `documentFruitSpec`。
- 不得出现“预约单缺少内置温湿度参数”的误判。
- 本地规则和 LLM 都必须能读取同一套内置参数。

### R-REV-03【最终】整改

- 不通过 → scheduler 读取原因 → master 确认整改指引 → 针对性修改 → 重提。
- 禁止原样重提。
- 记录 `documentRevision`、`rectificationCount`、`rectificationNotes`。
- 正式模式最多3次；演示模式最多6次。
- 达到上限终止，不写台账。

### R-REV-04【最终】边界

| 场景 | 处理 |
|---|---|
| 前置库房核验失败 | 回退 scheduler 重选，不是整改 |
| 到货吨位偏差>5% | 增加/更换库房，不是整改 |
| 单据字段/表述问题 | 整改重提 |
| 整改超过上限 | 终止，输出最后原因 |

## 6. COP 判定

### R-COP-01【最终】口径

- `single`：单库房，必须有库房编号，`COP=Q/W`。
- `allocated`：机组分摊，`Wi=Wtotal*Qi/Qtotal`，`COPi=Qi/Wi`。
- 两种口径分开存储、分开做5天历史均值。

### R-COP-02【最终】取数顺序

```text
有入库单 -> 正式核算（询问果品中心温度）
无入库单但有预约单 -> 预约预估（不询问中心温度）
两者都无 -> 核算异常警报，终止
```

### R-COP-03【最终】Q1

```text
q_resp = lookup(fruit, midpoint(recommendedTempRange))
Q1 = tonnage*1000 * q_resp
COP = Q1 / W
```

### R-COP-04【最终】Q2

```text
q_resp = lookup(fruit, centerTemp)
c = phaseSpecificHeat(fruit, freezingPoint, centerTemp)
Q2Sensible = mass*c*(centerTemp-roomTemp)/precoolHours
Q2Resp = mass*q_resp
Q2 = Q2Sensible + Q2Resp
COP = Q2 / W 或 Qi / Wi
```

### R-COP-05【最终】质检

- 异常值；
- 边界：formal 1.8~4.2，estimate 0.01~10；
- 5天同口径历史偏离 >5%；
- 最多3轮；
- 3轮失败 → 核算异常警报；
- 警报不阻塞到货/新预约；
- 手动菜单8解除。

### R-COP-06【最终】失败即警报

- 单据不存在/未质检/通讯异常/缺关键字段/q_resp越界/果品无表；
- 立即终止，不生成报告；
- 警报写具体原因；
- 不自动清除。

## 7. PLC 与设备异常

### R-PLC-01【最终】采样

- 默认5分钟；
- 保存2000条；
- 5天历史均值；
- 后台采样不生成报告。

### R-PLC-02【最终】长期异常

- 连续2小时（24个采样）异常；
- 单次扰动/被正常样本打断不判定；
- 标记库房/机组设备异常；
- Master 推送设备警报；
- Scheduler 禁止同机组新预约；
- 已入库不自动转移；
- 菜单9手动解除。

### R-ALM-01【最终】警报隔离

| 警报 | 阻止到货 | 阻止新预约 | 标记设备 |
|---|---|---|---|
| COP 核算异常 | 否 | 否 | 否 |
| 设备长期异常 | 否（已入库不阻断） | 是（同机组） | 是 |

## 8. 数据契约

### 8.1 预约单最小字段

```json
{
  "docId": "YY-YYYYMMDD-NNN",
  "docType": "appointment",
  "fruit": "杨梅|柚子|苹果",
  "tonnage": 10,
  "scheduledAt": "YYYY-MM-DD HH:mm",
  "storageDays": 7,
  "tempZone": "0.5~2°C",
  "humidity": "90%",
  "temperatureRequirement": "0.5~2°C",
  "humidityRequirement": "90%",
  "tempMinC": 0.5,
  "tempMaxC": 2,
  "fruitSpec": {
    "fruit": "杨梅",
    "tempMinC": 0.5,
    "tempMaxC": 2,
    "tempText": "0.5~2°C",
    "humidity": "90%"
  },
  "roomCode": "A1",
  "roomName": "A区1号冷库",
  "status": "booked",
  "reviewPassed": true,
  "createdBy": "external-user"
}
```

### 8.2 到货单最小字段

```json
{
  "docId": "RK-YYYYMMDD-NNN",
  "docType": "arrival",
  "appointmentId": "YY-YYYYMMDD-NNN",
  "fruit": "柚子",
  "actualTonnage": 12,
  "cargoTempC": 5,
  "tempZone": "5~10°C",
  "humidity": "85%",
  "temperatureRequirement": "5~10°C",
  "humidityRequirement": "85%",
  "fruitSpec": {
    "fruit": "柚子",
    "tempMinC": 5,
    "tempMaxC": 10,
    "tempText": "5~10°C",
    "humidity": "85%"
  },
  "actualInboundAt": "YYYY-MM-DD HH:mm:ss",
  "roomCode": "B1",
  "status": "received",
  "reviewPassed": true
}
```

### 8.3 `thermalPlcHistory` 最小字段

```json
{
  "recordedAt": "YYYY-MM-DD HH:mm:ss",
  "source": "estimate_cop|arrival_deviation_check",
  "appointmentId": "YY-...",
  "fruit": "柚子",
  "qRespConditionTempC": 7.5,
  "qRespConditionSource": "USDA...；Q1按7.5℃...",
  "actualCargoTempC": 6,
  "appointmentTonnage": 10,
  "actualTonnage": 12,
  "tonnageDeviationPct": 20,
  "plcSnapshot": {
    "timestamp": "YYYY-MM-DD HH:mm:ss",
    "powerW": 3000,
    "cop": 1.1
  }
}
```

### 8.4 COP 报告字段

`mode / copScope / roomCode / rooms[] / q1W / q2W / wPowerW / cop / plcSnapshot / sourceDocIds / thermalSource / thermalDetails / qRespConditions / scopeLabel / createdAt`

## 9. 已废止规则（禁止在平台回归中重新引入）

| 旧规则 | 状态 | 现行规则 |
|---|---|---|
| 到货货温与库房目标温度比较并触发重规划 | 已废止 | 温度不触发；只按吨位 |
| 到货货温与 q_resp 条件温度比较并触发重规划 | 已废止 | 温度仅记录；只按吨位 |
| 先让用户选库房，再由 reviewer 报温湿度不匹配 | 已废止 | 前置 reviewer 核验在用户选择之前 |
| 无合格库房仍进入 reviewer/让用户选 | 已废止 | 直接终止，不进入 reviewer |
| reviewer payload 不带内置果品温湿度参数 | 已废止 | 必须带 `builtInFruitSpecs`/`documentFruitSpec` |
| 预约表单收集果品温度 | 已废止 | 不收集；Q1用推荐温区中间温度 |
| 到货偏差重规划消耗普通整改次数 | 已废止 | 不消耗 |
| 无入库单/无预约单仍继续核算 | 已废止 | 生成核算异常警报并终止 |

## 10. 防回归断言

平台测试至少断言：

1. 温度极端但吨位一致时不触发重规划。
2. 吨位偏差>5%时触发，且 `deviations` 不含温度字段。
3. 无合格库房时 reviewer 调用次数为 0。
4. 前置核验失败时用户没有收到候选列表。
5. 柚子预约单 `tempZone=5~10°C`、`humidity=85%`，reviewer 通过。
6. reviewer 请求 payload 包含 `builtInFruitSpecs`。
7. 超时预约不产生到货单。
8. 选择“否”旧预约 `expired` 且库房释放。
9. 选择“是”完整重跑预约。
10. 整改超过上限不写台账。
11. COP 警报不阻止到货/新预约。
12. 设备异常阻止同机组新预约。
