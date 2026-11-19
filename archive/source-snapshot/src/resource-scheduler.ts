/**
 * 全局资源级任务调度器。
 *
 * 关键约束：
 * - PLC、LLM、Ledger 三个资源各自拥有独立队列和运行位；
 * - 同一资源同一时间只允许一个任务运行，新到任务排队等待；
 * - 不同资源可并行运行；
 * - 队列按 user > reviewer > background 优先级选择，同级 FIFO；
 * - 任务超时立即判定失败、释放资源并继续下一个任务；
 * - 调度器会向任务传递 AbortSignal，任务应尽量响应取消。
 */

import { managedConsoleLog } from "./console-gate";

export type ResourceName = "plc" | "llm" | "ledger";
export type TaskPriority = "user" | "reviewer" | "background";

export interface ResourceTaskOptions {
  resource: ResourceName;
  priority: TaskPriority;
  label: string;
  timeoutMs?: number;
}

export type ResourceTaskOutcome<T> =
  | {
      ok: true;
      resource: ResourceName;
      priority: TaskPriority;
      label: string;
      value: T;
      queueWaitMs: number;
      durationMs: number;
    }
  | {
      ok: false;
      resource: ResourceName;
      priority: TaskPriority;
      label: string;
      timedOut: boolean;
      error: string;
      failureMessage: string;
      queueWaitMs: number;
      durationMs: number;
    };

interface QueuedTask {
  resource: ResourceName;
  priority: TaskPriority;
  label: string;
  timeoutMs: number;
  enqueuedAt: number;
  resolve: (outcome: ResourceTaskOutcome<any>) => void;
  task: (signal: AbortSignal) => Promise<unknown> | unknown;
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  user: 0,
  reviewer: 1,
  background: 2,
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  user: "用户交互",
  reviewer: "质检员审核",
  background: "后台任务",
};

function envTimeout(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEFAULT_TIMEOUT_MS: Record<ResourceName, number> = {
  plc: envTimeout("PLC_TASK_TIMEOUT_MS", 5_000),
  llm: envTimeout("LLM_TASK_TIMEOUT_MS", 60_000),
  ledger: envTimeout("LEDGER_TASK_TIMEOUT_MS", 5_000),
};

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ResourceTaskScheduler {
  private readonly queues: Record<ResourceName, QueuedTask[]> = {
    plc: [],
    llm: [],
    ledger: [],
  };
  private readonly active: Record<ResourceName, boolean> = {
    plc: false,
    llm: false,
    ledger: false,
  };

  run<T>(
    options: ResourceTaskOptions,
    task: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<ResourceTaskOutcome<T>> {
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS[options.resource];

    return new Promise<ResourceTaskOutcome<T>>((resolve) => {
      const queued: QueuedTask = {
        resource: options.resource,
        priority: options.priority,
        label: options.label,
        timeoutMs,
        enqueuedAt: Date.now(),
        resolve: resolve as (outcome: ResourceTaskOutcome<any>) => void,
        task: task as (signal: AbortSignal) => Promise<unknown> | unknown,
      };
      this.queues[options.resource].push(queued);
      // 排队期间保持静默，只有真正开始执行时才输出日志。
      this.drain(options.resource);
    });
  }

  snapshot(): Record<
    ResourceName,
    { active: boolean; waiting: number; queue: Array<{ label: string; priority: TaskPriority }> }
  > {
    return {
      plc: this.snapshotResource("plc"),
      llm: this.snapshotResource("llm"),
      ledger: this.snapshotResource("ledger"),
    };
  }

  private snapshotResource(resource: ResourceName) {
    return {
      active: this.active[resource],
      waiting: this.queues[resource].length,
      queue: this.queues[resource].map((task) => ({
        label: task.label,
        priority: task.priority,
      })),
    };
  }

  private nextTaskIndex(resource: ResourceName): number {
    const queue = this.queues[resource];
    let selected = 0;
    for (let index = 1; index < queue.length; index += 1) {
      const current = queue[index];
      const best = queue[selected];
      const currentRank = PRIORITY_RANK[current.priority];
      const bestRank = PRIORITY_RANK[best.priority];
      if (
        currentRank < bestRank ||
        (currentRank === bestRank && current.enqueuedAt < best.enqueuedAt)
      ) {
        selected = index;
      }
    }
    return selected;
  }

  private drain(resource: ResourceName): void {
    if (this.active[resource] || this.queues[resource].length === 0) return;

    const queue = this.queues[resource];
    const next = queue.splice(this.nextTaskIndex(resource), 1)[0];
    this.active[resource] = true;
    const startedAt = Date.now();
    const queueWaitMs = startedAt - next.enqueuedAt;
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: ResourceTaskOutcome<unknown>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      this.active[resource] = false;

      if (outcome.ok) {
        managedConsoleLog(
          `[task-scheduler] 完成 resource=${resource} task=${next.label} duration=${outcome.durationMs}ms queueWait=${outcome.queueWaitMs}ms`,
        );
      } else {
        managedConsoleLog(
          `[task-scheduler] 失败 resource=${resource} task=${next.label} timedOut=${outcome.timedOut} error=${outcome.error}`,
        );
      }

      next.resolve(outcome);
      this.drain(resource);
    };

    managedConsoleLog(
      `[task-scheduler] 开始 resource=${resource} priority=${next.priority}(${PRIORITY_LABEL[next.priority]}) task=${next.label} timeout=${next.timeoutMs}ms`,
    );

    timer = setTimeout(() => {
      const failureMessage = `资源任务超时：${resource}/${next.label} 超过 ${next.timeoutMs}ms，本次任务失败，资源已释放。`;
      managedConsoleLog(`[task-scheduler] 超时 ${failureMessage}`);
      controller.abort(new Error(failureMessage));
      finish({
        ok: false,
        resource,
        priority: next.priority,
        label: next.label,
        timedOut: true,
        error: failureMessage,
        failureMessage,
        queueWaitMs,
        durationMs: Date.now() - startedAt,
      });
    }, next.timeoutMs);

    Promise.resolve()
      .then(() => next.task(controller.signal))
      .then(
        (value) => {
          if (settled) {
            managedConsoleLog(
              `[task-scheduler] 忽略已完成超时任务的迟到结果 resource=${resource} task=${next.label}`,
            );
            return;
          }
          finish({
            ok: true,
            resource,
            priority: next.priority,
            label: next.label,
            value,
            queueWaitMs,
            durationMs: Date.now() - startedAt,
          });
        },
        (error) => {
          if (settled) {
            managedConsoleLog(
              `[task-scheduler] 忽略已完成超时任务的迟到异常 resource=${resource} task=${next.label}`,
            );
            return;
          }
          const message = shortError(error);
          const failureMessage = `资源任务失败：${resource}/${next.label}，${message}`;
          finish({
            ok: false,
            resource,
            priority: next.priority,
            label: next.label,
            timedOut: false,
            error: message,
            failureMessage,
            queueWaitMs,
            durationMs: Date.now() - startedAt,
          });
        },
      );
  }
}

/** 应用全局唯一调度器实例。 */
export const resourceScheduler = new ResourceTaskScheduler();
