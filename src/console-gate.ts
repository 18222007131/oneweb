/**
 * 控制台日志闸门：
 * - 用户正在输入时，后台日志会被缓冲，不直接写终端；
 * - 输入结束后再统一 flush；
 * - 排队任务本身不产生日志，资源调度器只在任务真正开始后写日志。
 */

let interactiveInputActive = false;
const bufferedLogs: string[] = [];
const MAX_BUFFERED_LOGS = 500;

function writeLine(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function setInteractiveInputActive(active: boolean): void {
  interactiveInputActive = active;
  if (!active) {
    flushManagedLogs();
  }
}

export function isInteractiveInputActive(): boolean {
  return interactiveInputActive;
}

/** 后台/Agent日志：输入期间进入缓冲，不干扰正在编辑的命令行。 */
export function managedConsoleLog(message: string): void {
  const text = String(message);
  if (interactiveInputActive) {
    bufferedLogs.push(text);
    if (bufferedLogs.length > MAX_BUFFERED_LOGS) {
      bufferedLogs.shift();
    }
    return;
  }
  writeLine(text);
}

export function flushManagedLogs(): void {
  if (interactiveInputActive) return;
  while (bufferedLogs.length > 0) {
    writeLine(bufferedLogs.shift() as string);
  }
}

export function getBufferedLogCount(): number {
  return bufferedLogs.length;
}
