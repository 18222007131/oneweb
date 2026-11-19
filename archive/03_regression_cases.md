# 回归用例清单（人读版）

- 版本：v1.0.0-demo-baseline
- 冻结日期：2026-11-19
- 用例总数：49
- 机读文件：`03_regression_cases.json`
- 规则文件：`02_rules_and_boundaries.md`

> 所有用例均为 Demo 调试验收通过的最终规则。已废止的温度触发等旧规则不在此清单，见 `CHANGELOG.md`。

## 用例总表

| ID | 模块 | 用例 | 期望摘要 | 规则 | 状态 |
|---|---|---|---|---|---|
| ACC-001 | 账号与权限 | 内置库内账号自动登录 | 自动登录 admin；识别为库内账号；显示完整库内菜单 | REQ-ACC-01、REQ-ACC-02 | passed |
| ACC-002 | 账号与权限 | 切换账号并更新 lastLoggedIn | 当前账号切换；accounts.json 的 lastLoggedIn 更新；菜单权限随身份变化 | REQ-ACC-02 | passed |
| ACC-003 | 账号与权限 | 退出登录清空 lastLoggedIn | 清空 lastLoggedIn；回到登录提示；下次启动不自动登录 | REQ-ACC-02 | passed |
| ACC-004 | 账号与权限 | 库外账号菜单2/4/8/9隐藏并拦截 | 菜单不显示2/4/8/9；手动输入被权限拦截；Master 二次校验也拒绝 | REQ-ACC-03 | passed |
| ACC-005 | 账号与权限 | 库外台账仅返回本人预约单 | 仅返回 createdBy=当前账号 且 docType=appointment 的单据；不返回他人单据 | REQ-ACC-03、REQ-IN-08 | passed |
| MENU-001 | 菜单与控制台 | 任务完成后自动重打印菜单 | 自动打印完整菜单和编号；无需输入任意文字唤回 | REQ-MENU-01 | passed |
| QUE-001 | 资源队列 | PLC/LLM/ledger 串行与优先级 | 资源串行访问；用户 > reviewer > 后台优先级；无交叉破坏 | REQ-QUE-01、REQ-QUE-02 | passed |
| QUE-002 | 资源队列 | 资源任务超时释放并返回失败 | 超时释放资源；任务失败原因可见；后续任务可继续 | REQ-QUE-03 | passed |
| QUE-003 | 资源队列 | 用户输入期间后台日志不覆盖输入 | 后台日志缓冲；输入完成后打印；不打断当前输入 | REQ-QUE-04 | passed |
| IN-001 | 预约与库房 | 预约表单只收果品/吨位/时间/天数 | 不收集果品温度；不收集库房；不收集到货货温 | REQ-IN-01 | passed |
| IN-002 | 预约与库房 | 用户只能从候选库房选择 | 候选外库房被拒绝；只能选择通过前置核验的库房；选择后进入审核 | REQ-IN-06 | passed |
| IN-003 | 库房前置核验 | 库房硬预选六项全部校验 | A/C因品类/温区淘汰；B2因占用淘汰；只有B1进入候选 | R-ROOM-01、R-ROOM-02 | passed |
| IN-004 | 库房前置核验 | 前置reviewer核验通过才展示用户 | 用户看到的候选带 precheckStatus=reviewer_passed；展示前置Reviewer核验通过；之前不出现候选给用户 | R-ROOM-02 | passed |
| IN-005 | 库房前置核验 | 前置核验不通过回退scheduler重选 | 不进入用户选择；不进入普通整改；淘汰库房被排除 | R-ROOM-03 | passed |
| IN-006 | 库房前置核验 | 无合格库房直接终止 | 输出【暂时没有满足本次预约条件的合格库房】；输出暂无匹配库房；不上报reviewer | R-ROOM-04 | passed |
| IN-007 | 库房前置核验 | 全部果品内置温湿度参数及reviewer传递 | 柚子5~10°C/85%；杨梅0.5~2°C/90%；苹果-1~0°C/90% | R-REV-02、REQ-IN-06 | passed |
| IN-008 | 预约与库房 | 预约审核通过后库房占用 | 台账写入；reviewPassed=true；所选库房 occupancy=occupied | R-ROOM-05、REQ-IN-06 | passed |
| IN-009 | 到货与偏差 | 正常到货不触发重规划 | 不进入增加/更换库房；进入正常reviewer；台账新增到货单 | R-DEV-01、REQ-IN-07 | passed |
| IN-010 | 预约与库房 | 台账字段和库外过滤 | 记录 createdBy/roomCode/reviewPassed/reviewedAt；库外只见本人预约 | REQ-IN-08 | passed |
| DEV-001 | 到货与偏差 | 温度差异不触发重规划 | 不触发增加/更换库房；日志打印q_resp条件温度和实际货温；不输出货温偏差百分比 | R-DEV-01、R-DEV-02 | passed |
| DEV-002 | 到货与偏差 | 吨位偏差>5%触发重规划 | tonnageDeviationPct=20；进入增加/更换库房等待选择；deviations只含tonnagePct | R-DEV-01、R-DEV-03 | passed |
| DEV-003 | 到货与偏差 | 增加库房生成多库房分摊新单 | 新单号带-R1；roomAllocations含原库房和新增库房；addedRooms记录新增库房 | R-DEV-03、R-DEV-04 | passed |
| DEV-004 | 到货与偏差 | 更换库房释放原库房并更新预约 | 新单号带-R1；原库房释放；预约单库房更新 | R-DEV-04 | passed |
| DEV-005 | 到货与偏差 | q_resp条件温度与PLC写入热物性历史 | thermalPlcHistory同时含q_resp条件温度和plcSnapshot；预约单保存qRespConditionTempC；到货检查记录实际货温/吨位/吨位偏差 | R-DEV-02、REQ-DEV-06 | passed |
| TIM-001 | 入库超时 | 超时预约不生成到货单 | 判定入库超时；不组装到货单；不进入reviewer | R-TIM-01、R-TIM-02 | passed |
| TIM-002 | 入库超时 | 选择否作废旧预约并结束 | 旧预约status=expired/已失效；原库房释放；流程结束 | R-TIM-02 | passed |
| TIM-003 | 入库超时 | 选择是完整重跑预约流程 | 旧预约作废释放；重新进入候选库房；完整执行预约→筛选→前置核验→选择→审核→台账 | R-TIM-02 | passed |
| REV-001 | Reviewer整改 | 驳回后针对性整改并记录版本 | 读取具体原因；修改参数/表述；记录documentRevision/rectificationNotes | R-REV-03 | passed |
| REV-002 | Reviewer整改 | 正式模式3次兜底 | 最多3次；仍失败终止；不写台账 | R-REV-03 | passed |
| REV-003 | Reviewer整改 | 演示模式6次兜底 | 最多6次；优先整改；仍失败终止 | R-REV-03 | passed |
| REV-004 | Reviewer整改 | 失败原因对用户可见 | 展示具体字段/取值/规则原因；不能只显示审核失败 | R-REV-03 | passed |
| COP-001 | COP核算 | 单库房COP公式与标记 | COP=Q/W；标记【单库房COP】；输出库房编号/Q/W/COP | R-COP-01、REQ-COP-03 | passed |
| COP-002 | COP核算 | 机组分摊等效COP | Wi=Wtotal*Qi/Qtotal；COPi=Qi/Wi；标记【机组分摊等效COP】 | R-COP-01、REQ-COP-04 | passed |
| COP-003 | COP核算 | COP取数顺序 | 有入库单正式核算；无入库单有预约进预估；两者都无生成核算异常警报 | R-COP-02 | passed |
| COP-004 | COP核算 | Q1使用推荐温区中间温度 | q_resp条件温度1.25℃；31.5W/t；Q1=315W | R-COP-03、REQ-COP-05 | passed |
| COP-005 | COP核算 | Q2正式核算含显热和呼吸热 | Q2显热=m*c*ΔT/预冷时长；Q2呼吸=m*q_resp；Q2=两者之和 | R-COP-04、REQ-COP-06 | passed |
| COP-006 | COP核算 | COP三项质检和3轮重试 | 检查异常值/边界/5天偏离；最多3轮；3轮失败生成核算异常警报 | R-COP-05、REQ-PLC-02 | passed |
| COP-007 | COP核算 | 单据缺失/未质检/通讯异常立即警报 | 终止核算；不生成报告；生成核算异常警报 | R-COP-06、REQ-COP-08 | passed |
| COP-008 | COP核算 | COP输出完整字段 | COP类型/库房/Q1或Q2/W/COP/PLC/来源/热物性来源/查表说明 | REQ-COP-07 | passed |
| THERM-001 | 热物性与PLC | q_resp线性插值和c档位 | q_resp W/t按温度线性插值并÷1000；c按高于/低于冰点选档；档内不插值 | R-THERM-01、R-THERM-02 | passed |
| THERM-002 | 热物性与PLC | q_resp越界/果品无表生成警报 | 立即终止；不生成报告；核算异常警报写明查表失败原因 | R-COP-06 | passed |
| PLC-001 | 热物性与PLC | 5分钟后台采样和历史上限 | 默认5分钟；计算W/COP；最多保留2000条 | R-PLC-01 | passed |
| PLC-002 | 热物性与PLC | 5天历史均值和偏离 | 按同核算方式/同COP口径/单库房同库房取5天均值；偏离>5%报警；不跨口径混用 | R-COP-05、REQ-PLC-02 | passed |
| PLC-003 | 热物性与PLC | 连续2小时异常才判设备异常 | 连续24个5分钟采样异常才标记；单次扰动/被打断不标记 | R-PLC-02、REQ-PLC-03 | passed |
| PLC-004 | 热物性与PLC | 设备异常阻止同机组新预约 | A1/A2均不进入候选；已入库存货不自动转移；菜单9手动解除后恢复 | REQ-PLC-03 | passed |
| ALM-001 | 告警 | COP警报不阻塞到货和新预约 | 到货可继续；新预约可继续；COP警报不标记设备 | R-ALM-01 | passed |
| ALM-002 | 告警 | 两类警报手动解除 | 不输入确认不解除；解除后恢复对应能力；不自动清除 | R-ALM-01、REQ-PLC-04 | passed |
| AUD-001 | 日志审计 | 关键分支日志字段完整 | 账号/权限/库房比对/淘汰/前置核验/超时/偏差/选择/新方案/整改/COP/告警/资源队列均有留痕 | REQ-LOG-01、R-DEV-04 | passed |
| AUD-002 | 日志审计 | q_resp条件温度与PLC可回溯 | 记录q_resp条件温度/来源/实际货温/吨位/吨位偏差/PLC快照；可按预约单检索 | REQ-DEV-06 | passed |

## 模块统计

- 账号与权限：5 条
- 菜单与控制台：1 条
- 资源队列：3 条
- 预约与库房：4 条
- 库房前置核验：5 条
- 到货与偏差：6 条
- 入库超时：3 条
- Reviewer整改：4 条
- COP核算：8 条
- 热物性与PLC：6 条
- 告警：2 条
- 日志审计：2 条

## 使用说明

1. 平台回归时逐条对应 `03_regression_cases.json` 的 `steps` 和 `expected`；
2. `evidence` 指向日志或证据文件；平台应保留等价的结构化日志；
3. 规则变更必须新增用例并提升归档版本，不能直接改动已冻结用例的期望；
4. 涉及时间/PLC/LLM 的用例必须固定时钟、样本和模型返回，保证可复现。
