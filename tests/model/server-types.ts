import { model, prop } from "@ts-grm/core";

export const SERVER_TYPES = model(
  "ServerTypes",
  "id",
  class {
    id = prop.i64();
    label = prop.str(80);
    details = prop.text();
    active = prop.bool();
    small = prop.i16();
    quantity = prop.i32();
    ratio = prop.f32();
    total = prop.f64();
    amount = prop.num(12, 3);
    created = prop.dt();
    state = prop.enum("new", "done");
  },
);
