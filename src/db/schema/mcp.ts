import * as sq from "./sqlite/mcp.ts";
import * as pg from "./pg/mcp.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const mcpServers = m.mcpServers;
