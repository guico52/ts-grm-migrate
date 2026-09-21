import { ServerDdlGenerator } from "../server/ddl.js";
export class OracleDdlGenerator extends ServerDdlGenerator {
  constructor(schema: string) {
    super("oracle", schema);
  }
}
