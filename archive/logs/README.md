# 调试日志归档说明

本目录保存本次 Demo 调试验收中实际产生的**关键日志片段**，用于支撑回归用例与判定规则。

- 日志按主题分文件，不代表一次完整会话的连续输出；
- `[节选]` 表示从实际输出中截取的关键行，省略了无关菜单/等待行；
- 未保存的原始逐行输出不在此伪造；
- 平台回归应校验“关键字段/顺序/判定结果”，不要依赖某一句自然语言完全一致；
- 平台化后应输出结构化日志，并保留等价字段。

文件索引：

| 文件 | 对应主题 | 关联用例 |
|---|---|---|
| `01_room_precheck.log` | 柚子库房硬预选与前置核验 | IN-003、IN-004、IN-008 |
| `02_precheck_fail_reselect.log` | 前置核验失败、回退重选 | IN-005 |
| `03_no_room.log` | 无合格库房终止、设备异常 | IN-006、PLC-004 |
| `04_fruit_spec_reviewer.log` | 柚子内置温湿度与reviewer payload | IN-007 |
| `05_tonnage_only.log` | 仅吨位触发、温度留痕、热物性历史 | IN-009、DEV-001、DEV-002、DEV-005、AUD-002 |
| `06_arrival_replan.log` | 到货增加/更换库房 | DEV-003、DEV-004 |
| `07_timeout_rebook.log` | 入库超时与重新预约 | TIM-001、TIM-002、TIM-003 |
| `08_rectification.log` | reviewer驳回、针对性整改、3次兜底 | REV-001、REV-002、REV-004 |
| `09_cop_q1.log` | 预约COP预估与Q1/q_resp | COP-001、COP-003、COP-004、COP-008、THERM-001 |
