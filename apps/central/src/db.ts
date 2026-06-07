import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

const defaults: DbConfig = {
  host: "localhost",
  port: 5432,
  database: "uncorded_central",
  username: "postgres",
  password: "postgres",
};

export function createDb(overrides?: Partial<DbConfig>): Sql {
  const config = { ...defaults, ...overrides };
  return postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    max: 20,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}
