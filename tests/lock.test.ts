import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireProcessLock } from "../src/lock";

/** 一个几乎不可能存在的 pid（超出 Linux 默认 pid_max，kill 会 ESRCH） */
const DEAD_PID = 2147483646;

describe("进程锁文件", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-lock-"));
    lockPath = path.join(dir, "migrate.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("获取后写入持有者信息（pid + 获取时间）", async () => {
    const lock = await acquireProcessLock(lockPath);
    const info = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      acquiredAt: string;
    };
    expect(info.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(info.acquiredAt))).toBe(false);
    await lock.release();
  });

  it("已有活着的持有者时拒绝获取，并指出持有者", async () => {
    const lock = await acquireProcessLock(lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toThrow(
      new RegExp(`pid ${process.pid}`),
    );
    await lock.release();
  });

  it("stale 锁（持有者进程已不存在）可被抢占", async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString() }),
    );
    const lock = await acquireProcessLock(lockPath);
    const info = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(info.pid).toBe(process.pid);
    await lock.release();
  });

  it("锁文件损坏（非法 JSON）视为 stale，可被抢占", async () => {
    await writeFile(lockPath, "not-a-json");
    const lock = await acquireProcessLock(lockPath);
    await expect(stat(lockPath)).resolves.toBeDefined();
    await lock.release();
  });

  it("锁文件缺少 pid 字段同样视为 stale", async () => {
    await writeFile(lockPath, JSON.stringify({ acquiredAt: "x" }));
    const lock = await acquireProcessLock(lockPath);
    await lock.release();
  });

  it("release 后锁文件消失", async () => {
    const lock = await acquireProcessLock(lockPath);
    await lock.release();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("release 幂等：重复调用不报错", async () => {
    const lock = await acquireProcessLock(lockPath);
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("release 不删除已被他人抢占的锁", async () => {
    const lock = await acquireProcessLock(lockPath);
    // 模拟锁被抢占：文件内容换成另一个进程
    await writeFile(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, acquiredAt: new Date().toISOString() }),
    );
    await lock.release();
    // 文件仍在（属于别人），不能被本进程删掉
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("释放后可被再次获取", async () => {
    const first = await acquireProcessLock(lockPath);
    await first.release();
    const second = await acquireProcessLock(lockPath);
    await second.release();
  });
});
