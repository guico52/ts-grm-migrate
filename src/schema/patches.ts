import { diagnostic, asError } from "../diagnostics/error.js";
/**
 * 列级扩展元数据（`autoIncrement` / `default`）的适配层。
 *
 * 上游 ts-grm 的列元数据（`ColumnDef`）不表达自增与列默认值。补足能力由
 * 可选的 `ts-grm-patches` 包提供：它在 `spi.EntityProp` 上安装只读的
 * `autoIncrement` / `default` 读取器，值来自定义时的 `prop.i32().autoIncrement()`
 * / `prop.str(20).default('active')`。
 *
 * migrate 不在 `package.json` 里依赖该包，而是**结构化探测**这些成员是否存在：
 * - 存在（补丁已 `applyPatches()`，或上游将来原生提供）→ 这两个字段纳入管理；
 * - 不存在（未安装补丁）→ 保持旧行为（`autoIncrement: false` 恒非自增、
 *   `default: undefined` 不参与 diff），不会凭空删除数据库里已有的默认值。
 *
 * 探测按原型链（`in`）而不是类型导入，因此补丁包缺失、版本变化都不会让
 * migrate 崩溃；代价是「补丁已安装但某列未声明」与「未安装补丁」必须靠
 * 两个布尔量区分（`autoIncrementManaged` / `defaultManaged`）。
 *
 * 渲染（把默认值变成 `default <SQL>` 片段）属于消费方职责 —— 这正是本文件
 * 后半部分做的事；补丁只承载表达式节点，不生成 SQL。
 */
import type { DialectName } from '../dialect.js';

/** 补丁（或上游原生实现）挂在列 prop 上的元数据读取结果 */
export interface ColumnPatchMetadata {
  /** prop 暴露了 `autoIncrement`：模型声明自增成为权威（false = 明确非自增） */
  readonly autoIncrementManaged: boolean;
  readonly autoIncrement: boolean;
  /** prop 暴露了 `default`：模型声明默认值成为权威（未声明 = 应无默认值） */
  readonly defaultManaged: boolean;
  /** 原始默认值（字面量或上游表达式节点），未声明时为 undefined */
  readonly default: unknown;
}

const NOT_MANAGED: ColumnPatchMetadata = {
  autoIncrementManaged: false,
  autoIncrement: false,
  defaultManaged: false,
  default: undefined,
};

/**
 * 读取列 prop 上的扩展元数据。
 *
 * getter 读取失败必须中止：不能把失败解释成删除默认值或取消自增。
 */
export function readColumnPatch(prop: unknown): ColumnPatchMetadata {
  if (prop == null || (typeof prop !== 'object' && typeof prop !== 'function')) {
    return NOT_MANAGED;
  }
  const autoIncrementManaged = hasMember(prop, 'autoIncrement');
  const defaultManaged = hasMember(prop, 'default');
  if (!autoIncrementManaged && !defaultManaged) {
    return NOT_MANAGED;
  }
  return {
    autoIncrementManaged,
    autoIncrement: autoIncrementManaged ? readBoolean(prop, 'autoIncrement') : false,
    defaultManaged,
    default: defaultManaged ? readMember(prop, 'default') : undefined,
  };
}

/** 原型链探测：补丁把读取器装在 `spi.EntityProp.prototype` 上 */
function hasMember(target: object, key: string): boolean {
  try {
    return key in target;
  } catch {
    return false;
  }
}

function readMember(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch (error) {
    throw diagnostic("schema_patches_1", key, asError(error));
  }
}

function readBoolean(target: object, key: string): boolean {
  const value = readMember(target, key);
  if (typeof value !== 'boolean') throw diagnostic("schema_patches_2", key);
  return value;
}

/** 渲染默认值所需的上下文（错误信息与方言字面量都要用到） */
export interface RenderDefaultContext {
  readonly table: string;
  readonly column: string;
  readonly dialect: DialectName;
}

/**
 * 把模型侧默认值渲染成可直接放入 DDL 的 SQL 片段。
 *
 * - 字面量：按方言转义（字符串加引号并转义单引号；布尔在 PostgreSQL / SQLite
 *   用 `true` / `false`，在把布尔存为数值的方言用 `1` / `0`）；
 * - 表达式：只接受上游 `dsl.native.*` 这类「模板片段 + 插值」的表达式节点
 *   （有 `parts`）。非 native 表达式（如列引用、聚合）在 DDL 里没有意义，
 *   直接报错而不是拼出一段看似合法的 SQL。
 *   SQLite / MySQL 的默认值只能是字面量或**带括号**的表达式，因此这里包一层括号
 *   （SQLite 存回 `dflt_value` 时会去掉外层括号，differ 的归一化能对上）。
 *
 * 返回值与数据库 introspect 回来的默认值文本可能写法不同（如 PG 会补
 * `::character varying`）；等价判定由 differ 的归一化负责（见 `src/differ.ts`）。
 */
export function renderColumnDefault(value: unknown, context: RenderDefaultContext): string {
  if (isLiteral(value)) {
    return renderLiteral(value, context);
  }
  if (isNativeExpression(value)) {
    const sql = renderNativeParts(value.parts, context);
    return context.dialect === 'sqlite' || context.dialect === 'mysql' ? `(${sql})` : sql;
  }
  throw diagnostic("schema_patches_3", context.table, context.column);
}

function isLiteral(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

interface NativeExpressionLike {
  readonly parts: ReadonlyArray<unknown>;
}

function isNativeExpression(value: unknown): value is NativeExpressionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

/**
 * 拼装 `dsl.native.*` 的模板片段。
 *
 * parts 的元素可能是：
 * - `string`：模板里原样保留的 SQL 片段（`now()`、`'a' || `）；
 * - 插值节点（`{ value, _explicitDataType }`）：DSL 对插值做的字面量包装，
 *   这里按 JS 值渲染；
 * - 嵌套表达式（有 `parts`）：递归；
 * - 数组（`dsl.native` 的集合插值）：在默认值场景没有意义，报错。
 */
function renderNativeParts(parts: ReadonlyArray<unknown>, context: RenderDefaultContext): string {
  let sql = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      sql += part;
      continue;
    }
    if (isNativeExpression(part)) {
      sql += renderNativeParts(part.parts, context);
      continue;
    }
    if (isLiteral(part)) {
      sql += renderLiteral(part, context);
      continue;
    }
    if (isInterpolatedValue(part)) {
      sql += renderInterpolated(part.value, context);
      continue;
    }
    throw diagnostic("schema_patches_4", context.table, context.column);
  }
  return sql;
}

/** DSL 对模板插值的包装（`{ value, _explicitDataType }`） */
function isInterpolatedValue(value: unknown): value is { readonly value: unknown } {
  return (
    typeof value === 'object' && value !== null && 'value' in value && '_explicitDataType' in value
  );
}

function renderInterpolated(value: unknown, context: RenderDefaultContext): string {
  if (value instanceof Date) {
    return quoteStringLiteral(value.toISOString());
  }
  if (Array.isArray(value)) {
    throw diagnostic("schema_patches_5", context.table, context.column);
  }
  if (isLiteral(value)) {
    return renderLiteral(value, context);
  }
  if (isNativeExpression(value)) {
    return renderNativeParts(value.parts, context);
  }
  throw diagnostic("schema_patches_6", context.table, context.column);
}

/** 字面量 → 方言 SQL 片段 */
function renderLiteral(
  value: string | number | boolean | bigint,
  context: RenderDefaultContext,
): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    // MySQL 的默认值经 introspect 统一加引号（含数值），这里保持同一写法，
    // 否则目标态与现状永远对不上（见 src/introspector/mysql.ts）。
    return `${context.dialect === 'mssql' ? 'N' : ''}${quoteStringLiteral(value)}`;
  }
  if (typeof value === 'boolean') {
    switch (context.dialect) {
      case 'postgres':
      case 'sqlite':
        return value ? 'true' : 'false';
      default:
        // MySQL / SQL Server / Oracle 用数值存布尔
        return context.dialect === 'mysql'
          ? quoteStringLiteral(value ? '1' : '0')
          : value
            ? '1'
            : '0';
    }
  }
  // number
  return context.dialect === 'mysql' ? quoteStringLiteral(String(value)) : String(value);
}

/** SQL 字符串字面量（所有目标方言都用单引号 + 双写转义） */
function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
