/**
 * 测试实体模型 —— 供 EntityManager 加载，驱动 createSchema 真实链路。
 *
 * 覆盖迁移测试需要的关联形态：
 * - m2o：BOOK.author → BOOK 表上的 AUTHOR_ID 外键列（joinColumns 指定级联）
 * - o2m：AUTHOR.books（反向侧，mappedBy 指向 m2o 属性，不产生列）
 * - m2m：BOOK.tags ↔ TAG.books，拥有侧 joinTable 定义中间表 book_tag_mapping
 * 多态/继承/enum/embedded/formula 等复杂场景暂不覆盖（后续按需补充）。
 *
 * 模块实例约定：@ts-grm/* 一律走 ESM import（与 src/vendor 及 tests/util 同一份实例）。
 * 曾用 createRequire 取 CJS 实例；依赖改为 npm 包后 CJS 与 ESM 会形成两份
 * EntityManager/model/prop（实测 ESM !== CJS），混用会导致运行时方法丢失。
 */
import { model, prop } from "@ts-grm/core";

export const AUTHOR = model("Author", "id", class {
  id = prop.i64()
  name = prop.str(50)
  age = prop.i32().nullable()
  // o2m 反向侧：FK 列在 BOOK.author 上，本表不产生列
  books = prop.o2m(BOOK).mappedBy("author")
});

export const BOOK = model("Book", "id", class {
  id = prop.i64()
  title = prop.str(100)
  // m2o：BOOK 表产生 AUTHOR_ID 外键列，级联删除
  author = prop.m2o(AUTHOR)
    .joinColumns({ cascade: "DELETE" })
    .nullable()
  // m2m 拥有侧：joinTable 定义中间表 book_tag_mapping
  tags = prop.m2m(TAG)
    .joinTable({
      name: "book_tag_mapping",
      joinThisColumns: ["book_id"],
      joinTargetColumns: ["tag_id"],
    })
});

export const TAG = model("Tag", "id", class {
  id = prop.i64()
  name = prop.str(30)
  // m2m 反向侧：指向 BOOK.tags
  books = prop.m2m(BOOK).mappedBy("tags")
});
