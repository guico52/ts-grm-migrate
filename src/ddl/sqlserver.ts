import { ServerDdlGenerator } from "../server/ddl.js";
export class SqlServerDdlGenerator extends ServerDdlGenerator {
  constructor(schema = "dbo") {
    super("mssql", schema);
  }
}
