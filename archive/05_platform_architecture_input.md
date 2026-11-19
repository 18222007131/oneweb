# 平台架构开发输入

- 版本：`v1.0.0-demo-baseline`
- 用途：下一步平台架构规划的需求输入，不是最终架构设计
- 原则：**业务规则冻结；平台只改变承载方式，不改变判定语义**

## 1. 平台目标

把当前 CLI + LangGraph + 内存 State 的 Demo 升级为可持久化、可并发、可审计、可配置的冷库业务平台，同时保留本归档全部业务规则。

平台应支持：

- 多用户、正式认证与 RBAC；
- 库房、预约、到货、单据、COP、告警的持久化；
- 多 Agent 协作的可观测工作流；
- PLC/传感器数据接入与历史分析；
- 规则/热物性参数可配置、可版本化；
- 回归用例自动化执行；
- 审计、告警、人工干预和运营报表。

## 2. 领域划分（建议 bounded context）

| 领域 | 职责 | 关键对象 |
|---|---|---|
| Identity & Access | 账号、登录、角色、权限、会话 | User、Role、Permission、Session |
| Room & Inventory | 库房、温区、容量、机组、适配品类、占用 | ColdRoom、Unit、RoomInventory |
| Reservation | 预约、时段、容量冲突、库房候选 | Appointment、RoomCandidate、Precheck |
| Inbound | 到货、超时、偏差、重规划、多库房分摊 | Arrival、ReplanDecision、RoomAllocation |
| Document Workflow | 单据审核、整改、版本、状态机 | Document、Revision、ReviewTask |
| Thermal & COP | 热物性、q_resp/c、Q1/Q2、单库房/分摊COP | ThermalTable、CopCalculation、CopReport |
| PLC & Monitoring | 采样、历史、5天均值、长期异常 | PlcSample、DeviceAlarm、Sensor |
| Alerting | 核算异常、设备异常、手动解除 | Alarm、Acknowledge |
| Resource Scheduling | PLC/LLM/ledger 队列、优先级、超时 | ResourceLease |
| Audit & Reporting | 结构化日志、审计、报表、导出 | AuditEvent、Report |

## 3. 核心数据模型（平台化建议）

### 3.1 用户与权限

```text
user(id, username, password_hash/nullable_for_migration, user_type, status, created_at)
role(id, code, name)
permission(id, code, description)
user_role(user_id, role_id)
session(id, user_id, expires_at, last_seen_at)
```

- 平台正式认证不得沿用 Demo 的“只输账号名”。
- 库内/库外是角色或用户类型，但权限必须落到 permission code。
- 迁移期可保留 `external`/`internal` 兼容字段，但授权以 RBAC 为准。

### 3.2 库房与库存

```text
unit(id, code, name, status)
cold_room(id, code, name, unit_id, temp_min_c, temp_max_c, humidity_pct,
          capacity_tons, suitable_fruits, bookable, status, version)
room_occupancy(id, room_id, source_type, source_id, occupied_from, occupied_to, status)
```

- `room.code` 唯一，格式 `A1`/`B2`。
- 适配品类、温湿度、容量、机组状态是预选硬条件。
- 占用必须有来源单据和释放时间，禁止无来源占用/释放。

### 3.3 预约与到货

```text
appointment(id, doc_no, fruit, tonnage, scheduled_at, storage_days,
            temp_zone, humidity, temperature_requirement, humidity_requirement,
            temp_min_c, temp_max_c, fruit_spec_version,
            room_id, status, review_status, created_by, created_at, version)

arrival(id, doc_no, appointment_id, fruit, actual_tonnage, cargo_temp_c,
        temp_zone, humidity, temperature_requirement, humidity_requirement,
        actual_inbound_at, room_id, status, review_status,
        replan_of, replan_choice, replan_revision, created_by, created_at, version)

room_allocation(id, arrival_id, room_id, role, allocated_tonnage, created_at)
```

- 单据号建议服务端生成，唯一、可追溯。
- 预约/到货状态机化，禁止直接改状态。
- `fruit_spec_version` 固化当时使用的内置参数版本，避免参数更新影响历史单据。

### 3.4 单据版本与整改

```text
document_revision(id, document_type, document_id, revision_no,
                  payload_json, change_summary, reason, created_by, created_at)
review_task(id, document_type, document_id, reviewer_id, status,
            result, reason, started_at, finished_at)
```

- 每次整改生成新 revision，不覆盖历史。
- reviewer 必须读取 revision + 内置参数快照。
- 禁止原样重提：平台应检测 payload 无变化时拒绝提交。

### 3.5 热物性与 COP

```text
thermal_table(id, fruit, temp_c, q_resp_w_per_ton, source, version, effective_from)
thermal_phase(id, fruit, phase, c_kj_per_kg_k, freezing_point_c, version)
cop_calculation(id, mode, cop_scope, room_id, unit_id, q1_w, q2_w,
                power_w, cop, plc_sample_id, source_doc_ids, thermal_version,
                status, created_at, created_by)
cop_report(id, calculation_id, report_no, payload_json, qc_status, created_at)
cop_room_allocation(id, calculation_id, room_id, q_w, share_pct, allocated_power_w, cop)
```

- 热物性表必须版本化、可配置、可审计。
- COP 计算保存输入/输出/参数版本，保证可复算。
- 单库房与机组分摊分开存储、分开历史比对。

### 3.6 PLC 与历史

```text
plc_sample(id, unit_id, room_id, sampled_at, supply_temp_c, return_temp_c,
           suction_pressure_mpa, discharge_pressure_mpa, power_w, cop,
           cooling_capacity_w, source, quality)
thermal_plc_history(id, appointment_id, fruit, q_resp_condition_temp_c,
                    q_resp_source, actual_cargo_temp_c, appointment_tonnage,
                    actual_tonnage, tonnage_deviation_pct,
                    plc_sample_id, recorded_at, source)
```

- `thermal_plc_history` 必须同时关联 q_resp 条件温度和 PLC 样本。
- PLC 采样建议时序库/分区表，保留策略和聚合策略明确。
- 5天均值、2小时长期异常由查询/聚合服务实现，不能在前端算。

### 3.7 告警

```text
alarm(id, type, severity, scope_type, scope_id, source, reason, status,
      raised_at, acknowledged_at, acknowledged_by, payload_json)
```

- `type`：COP_ANOMALY / DEVICE_ABNORMAL。
- 手动解除必须记录人、时间、确认文本。
- COP 告警不阻止到货/新预约；设备告警阻止同机组新预约。

## 4. 命令/查询/事件契约（建议）

### 4.1 命令

- `CreateAppointment`
- `QueryRoomCandidates`
- `PrecheckRoomCandidates`
- `ConfirmRoomChoice`
- `SubmitAppointmentForReview`
- `SubmitArrival`
- `CheckArrivalTimeout`
- `EvaluateArrivalDeviation`
- `ReplanArrival(add|change)`
- `ApproveDocument` / `RejectDocument`
- `RectifyDocument`
- `RequestCop`
- `ManualClearCopAlarm`
- `ManualClearDeviceAlarm`

### 4.2 查询

- `GetRoomInventory`
- `GetRoomCandidates`
- `GetAppointment`
- `GetArrival`
- `GetLedger`
- `GetCopReport`
- `GetThermalPlcHistory`
- `GetAlarms`
- `GetAuditTrail`

### 4.3 领域事件

- `AppointmentCreated`
- `RoomCandidatesPrechecked`
- `RoomChoiceConfirmed`
- `AppointmentReviewed`
- `ArrivalReceived`
- `ArrivalTimedOut`
- `ArrivalDeviationDetected`
- `ArrivalReplanned`
- `DocumentRectified`
- `CopCalculated`
- `CopQualityChecked`
- `CopAlarmRaised`
- `DeviceAbnormalDetected`
- `AlarmCleared`

事件必须带：

- `event_id`、`occurred_at`、`correlation_id`、`causation_id`；
- `actor`（用户/Agent/系统）；
- `entity_type`、`entity_id`；
- `rule_version`；
- `payload_snapshot`。

## 5. 工作流与状态机

### 5.1 预约

```text
DRAFT
 -> ROOM_QUERY
 -> ROOM_PRECHECK
 -> WAITING_USER_ROOM
 -> DOCUMENT_ASSEMBLED
 -> REVIEWING
 -> RECTIFYING (loop, max 3/6)
 -> APPROVED -> LEDGERED
 -> REJECTED/TERMINATED
```

### 5.2 到货

```text
RECEIVED_INPUT
 -> TIMEOUT_CHECK
    -> TIMEOUT_WAIT_USER -> EXPIRED / REBOOKING
 -> DEVIATION_CHECK (tonnage only)
    -> WAIT_REPLAN -> REPLANNED -> REVIEWING
    -> REVIEWING
 -> APPROVED -> LEDGERED
 -> REJECTED/TERMINATED
```

### 5.3 COP

```text
REQUESTED
 -> DOC_RETRIEVAL
    -> FORMAL -> PLC_SAMPLE -> CALC -> QC -> REPORT
    -> ESTIMATE -> PLC_SAMPLE -> CALC -> QC -> REPORT
    -> NO_DOC -> ALARM
 -> QC_RETRY (max 3)
 -> ALARM
```

- 状态机转换必须持久化、幂等、可恢复。
- LangGraph 可以保留为编排实现，但业务状态不能只存在图内存中。

## 6. 持久化与一致性

- 生产数据库：PostgreSQL（建议）或同等关系库；PLC 时序可另选时序库。
- 关键实体使用乐观锁 `version`，防止并发覆盖。
- 单据号、房间占用、台账提交必须事务化。
- 文件/大字段（报告、日志）对象存储，数据库存引用。
- 所有状态变更写审计事件（outbox 模式）。
- 预约/到货/COP 的读模型可做 CQRS 投影，但写模型保持事务一致。

## 7. 认证、授权与安全

- 正式登录（密码/SSO），密码哈希，会话/Token 过期。
- 权限 code 与菜单/API 双重校验，不能只隐藏前端。
- 库外用户数据隔离到 `created_by`。
- 敏感配置（DeepSeek Key、PLC 凭据）走密钥管理，不入库/不入源码。
- 审计日志不可篡改/可导出。
- 时区统一 Asia/Shanghai，数据库存 UTC + 业务时区展示。

## 8. 资源与异步任务

- 平台化后 PLC/LLM/ledger 仍需限流与优先级：
  - 用户交互 > reviewer > 后台；
  - 每个资源独立队列/租约；
  - 超时释放、幂等重试、死信。
- LLM 调用必须有超时、重试、熔断、用量统计。
- PLC 采样是后台定时任务，不能阻塞用户请求。
- 台账写操作串行化或使用数据库约束保证一致性。

## 9. 可观测性

- 结构化日志字段：
  - `trace_id/session_id/user_id/role/agent/task_type`;
  - `doc_no/room_code/fruit`;
  - `rule_id/decision/result/reason`;
  - `duration/queue_wait/resource`.
- 指标：
  - 预约成功率、无库房率、前置核验淘汰率；
  - 整改次数、超时率、偏差重规划率；
  - COP 成功率、QC 失败率、告警数；
  - PLC 采样延迟/缺失率。
- 链路追踪贯穿 master→scheduler→reviewer→xiaoke。
- 告警与审计可查询、可导出。

## 10. 回归测试挂载

平台必须提供测试适配层：

1. 导入 `03_regression_cases.json`；
2. 固定时钟/PLC 样本/LLM mock/热物性版本；
3. 通过 API/命令重放用例；
4. 对 `expected` 做结构化断言；
5. 对日志/审计断言关键字段；
6. 输出 JUnit/JSON 报告，关联 case id 和 rule id；
7. 回归失败阻断发布。

建议测试分层：

- 领域单元测试（规则/公式/状态机）；
- 应用服务集成测试（DB/事务/outbox）；
- 端到端测试（预约→到货→COP）；
- 契约测试（Agent/资源队列）；
- 回归基线测试（本归档 49 条）。

## 11. 从 Demo 迁移

| Demo | 平台 |
|---|---|
| CLI 菜单 | Web/移动端 + API |
| MemorySaver | PostgreSQL/Redis |
| 内存台账 | 单据表 + 审计表 |
| 内存 PLC 历史 | 时序库/分区表 |
| `accounts.json` | 用户/角色/权限表 |
| 本地 PLC 模拟 | 设备接入网关 |
| 本地 DeepSeek Mock | LLM 网关 + 配额/审计 |
| 控制台日志 | 结构化日志/追踪 |
| 手工回归 | 自动化回归基线 |

迁移顺序建议：

1. 领域模型与规则服务；
2. 持久化与状态机；
3. 认证/RBAC；
4. API/前端；
5. PLC/LLM 接入；
6. 回归基线接入；
7. 灰度与数据迁移。

## 12. 非功能要求

- 库房容量 2000t；
- PLC 默认5分钟，最小3秒仅调试；
- 历史2000条/至少5天；
- 长期异常2小时/24采样；
- 预约时间本地时区；
- 用户输入不被后台日志打断（平台为前端交互，不适用但等价要求为请求隔离）；
- 关键操作幂等；
- 审计可追溯；
- 单次 COP 计算可复算；
- 规则/热物性版本可回滚。

## 13. 开放决策（架构阶段确认）

1. 工作流引擎：LangGraph 保留、Temporal，或自研状态机？
2. PLC 接入协议与采样频率是否固定5分钟？是否支持多设备？
3. 热物性参数维护权限与审批流程？
4. COP 报告是否需要 PDF/签署/归档？
5. 库外用户是否需要注册/审核，还是仅内部代录？
6. 设备异常时已入库货品的换库工单是否纳入平台？
7. 告警通知渠道（站内/短信/邮件/企业微信）？
8. 多冷库/多园区是否需要租户隔离？
9. 单据号规则是否按园区/年份/类型分段？
10. 历史数据迁移范围和保留年限？

## 14. 架构阶段验收输入

架构方案至少回答：

- 领域边界和数据所有权；
- 单据状态机与并发控制；
- 库房占用的事务一致性；
- 前置核验/用户选择的时序保证；
- 到货偏差只按吨位的规则落点；
- q_resp+PLC 历史的数据模型；
- COP 可复算与版本化；
- 告警隔离与手动解除；
- 回归用例如何自动执行；
- Demo 到平台的迁移路径。

**业务规则不在架构阶段重新讨论；如确需变更，先更新归档版本。**
