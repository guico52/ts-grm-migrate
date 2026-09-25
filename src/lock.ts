/**
 * 进程锁文件 —— 防止同一项目上并发运行多个 migrate 实例。
 *
 * 定位（见 docs/design.md 设计决策）：migrate 是开发期独立进程工具，每次运行都是全新进程
 * （`ALL_MODEL_MAP` 天然干净）。锁文件用**文件系统**做进程间互斥，在连数据库之前
 * 就能拒绝并发，避免两条迁移/DDL 交叉。
 *
 * 设计要点：
 * - 锁文件内容为 `{ pid, acquiredAt }`，不只看文件是否存在 —— 进程崩溃（如 Ctrl-C）
 *   会留下 stale 锁，只看存在性会让项目永久卡住、必须手工删文件。
 * - 获取时检测持有者进程是否还活着（`process.kill(pid, 0)`）：活着则拒绝，死了则抢占。
 * - 释放时只删**自己的**锁，避免误删别人抢到的锁。
 * - 锁文件损坏（非法 JSON / 空文件）视为 stale：无从判断持有者，只能抢占。
 */
import { open, readFile, unlink } from "node:fs/promises";

export interface ProcessLock {
  /** 锁文件路径 */
  readonly path: string;
  /** 释放锁（幂等；只删属于自己的锁） */
  release(): Promise<void>;
}

/** 锁文件内容 */
interface LockInfo {
  readonly pid: number;
  readonly acquiredAt: string;
}

/** 抢占 stale 锁时的最大重试次数（避免两个进程互相抢占导致无限循环） */
const MAX_ATTEMPTS = 3;

/**
 * 获取进程锁；已有活着的持有者时抛出可读错误。
 *
 * @param lockPath 锁文件路径（通常在项目根）
 */
export async function acquireProcessLock(lockPath: string): Promise<ProcessLock> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const acquired = await tryCreate(lockPath);
    if (acquired) {
      return makeLock(lockPath);
    }

    const holder = await readLockInfo(lockPath);
    if (holder != null && isProcessAlive(holder.pid)) {
      throw new Error(
        `Another migration process holds ${lockPath} (pid ${holder.pid}, since ${holder.acquiredAt}). ` +
          `If that process no longer exists, remove the lock file and retry.`,
      );
    }

    // 持有者已不存在（或锁文件损坏）：抢占
    await unlink(lockPath).catch(() => undefined);
  }

  throw new Error(
    `Could not acquire migration lock ${lockPath} after ${MAX_ATTEMPTS} attempts; other processes may be competing`,
  );
}

/** 独占创建锁文件并写入持有者信息；已被占用返回 false */
async function tryCreate(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw e;
  }
  try {
    const info: LockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await handle.writeFile(JSON.stringify(info));
    return true;
  } finally {
    await handle.close();
  }
}

function makeLock(lockPath: string): ProcessLock {
  return {
    path: lockPath,
    async release(): Promise<void> {
      const info = await readLockInfo(lockPath);
      // 只在锁仍属于本进程时删除：避免误删被其他进程抢占后的新锁
      if (info == null || info.pid === process.pid) {
        await unlink(lockPath).catch(() => undefined);
      }
    },
  };
}

/** 读取锁文件；不存在或损坏返回 null（损坏按 stale 处理） */
async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number"
    ) {
      const info = parsed as { pid: number; acquiredAt?: unknown };
      return {
        pid: info.pid,
        acquiredAt: typeof info.acquiredAt === "string" ? info.acquiredAt : "(unknown)",
      };
    }
  } catch {
    // 落到下面按 stale 处理
  }
  return null;
}

/**
 * 进程是否还活着。`kill(pid, 0)` 不发信号，只做存在性与权限检查：
 * - 正常返回 → 存在；
 * - `EPERM` → 存在但无权限发信号（仍算活着）；
 * - `ESRCH` → 不存在。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
