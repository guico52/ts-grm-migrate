/**
 * 快照 —— migrate 的统一比较形状 Schema 的持久化形态。
 *
 * 目标态（适配器产出）与现状（introspection 产出）都是 Schema（纯数据、无方法、
 * 无循环引用），快照 = Schema 的 JSON 序列化。diff / 漂移校验都直接对比同一形状。
 *
 * 快照文件结构：
 * ```json
 * {
 *   "formatVersion": 1,
 *   "schema": { "tables": [...] }
 * }
 * ```
 * formatVersion 用于未来格式演进（migrate 自由设计，不受 ts-grm 约束）。
 */
import type { Schema } from "./schema/model.js";

/** 快照文件格式版本 */
export const SNAPSHOT_FORMAT_VERSION = 1 as const;

export interface SchemaSnapshot {
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  readonly schema: Schema;
}

/** Schema → 快照 JSON 字符串（可读格式） */
export function toSnapshot(schema: Schema): string {
  const snapshot: SchemaSnapshot = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schema,
  };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 快照 JSON 字符串 → Schema。
 * 外部输入路径（快照文件可能被手改/损坏/跨版本），先校验形状，失败抛出可读错误。
 */
export function fromSnapshot(json: string): Schema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Snapshot is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(parsed) || typeof parsed.formatVersion !== "number") {
    throw new Error("Invalid snapshot: missing formatVersion");
  }
  if (parsed.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Incompatible snapshot format: file is v${parsed.formatVersion}, engine supports v${SNAPSHOT_FORMAT_VERSION}`,
    );
  }
  if (!isSchema(parsed.schema)) {
    throw new Error("Invalid snapshot: schema shape mismatch");
  }
  return parsed.schema;
}

// ---- 运行时形状校验（类型守卫）--------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Schema 形状校验（快照反序列化的安全网） */
export function isSchema(value: unknown): value is Schema {
  if (!isRecord(value)) return false;
  const { tables } = value;
  if (!Array.isArray(tables)) return false;
  return tables.every(isTable);
}

function isTable(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { name, columns, constraints, indexes } = value;
  if (!isString(name)) return false;
  if (!Array.isArray(columns) || !columns.every(isColumn)) return false;
  if (!Array.isArray(constraints) || !constraints.every(isConstraint)) return false;
  if (!Array.isArray(indexes) || !indexes.every(isIndex)) return false;
  return true;
}

function isColumn(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { name, type, nullable, length, default: def, autoIncrement, ordinal, comment } = value;
  return (
    isString(name) &&
    isString(type) &&
    isBoolean(nullable) &&
    (length === undefined || typeof length === "number") &&
    isOptionalString(def) &&
    isBoolean(autoIncrement) &&
    typeof ordinal === "number" &&
    isOptionalString(comment) &&
    isOptionalString(value.defaultConstraint) &&
    isOptionalString(value.collation) &&
    (value.mysql === undefined || (isRecord(value.mysql) && isOptionalString(value.mysql.charset) && isOptionalString(value.mysql.collation) && isOptionalString(value.mysql.onUpdate)))
  );
}

function isConstraint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { kind, name, columns } = value;
  if (kind !== "PRIMARY_KEY" && kind !== "UNIQUE" && kind !== "FOREIGN_KEY" && kind !== "CHECK") {
    return false;
  }
  if (!isOptionalString(name)) return false;
  switch (kind) {
    case "PRIMARY_KEY":
    case "UNIQUE":
      return isStringArray(columns);
    case "FOREIGN_KEY": {
      const { referencedTable, referencedColumns, onDelete, deferrable } = value;
      return (
        isStringArray(columns) &&
        isString(referencedTable) &&
        isStringArray(referencedColumns) &&
        (onDelete === "NO_ACTION" || onDelete === "RESTRICT" || onDelete === "CASCADE" ||
          onDelete === "SET_NULL" || onDelete === "SET_DEFAULT") &&
        isBoolean(deferrable)
      );
    }
    case "CHECK": {
      const { expression, values } = value;
      return (
        isString(expression) && isOptionalString(value.comparisonExpression) &&
        (values === undefined || (Array.isArray(values) && values.every((v) => typeof v === "string" || typeof v === "number")))
      );
    }
  }
}

function isIndex(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { name, columns, unique, predicate } = value;
  return (
    isString(name) &&
    isStringArray(columns) &&
    isBoolean(unique) &&
    isOptionalString(predicate) && (value.implicit === undefined || isBoolean(value.implicit))
  );
}
