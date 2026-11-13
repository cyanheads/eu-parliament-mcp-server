/**
 * @fileoverview Server-specific environment configuration: the `limit` clamp switch.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      "Normalize bounded-mode limits with a notice; false rejects limits above a fully bounded tool's largest bound, adopted texts counting their search window. Whole-acquired local modes have no output-size cap",
    ),
});

/** Parsed server-specific configuration. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const defaults = ServerConfigSchema.parse({});
let config: ServerConfig | undefined;

/**
 * Parse the server environment. Called in `createApp`'s `setup()`, after the framework has
 * loaded `.env`; an unrecognized value throws a `ConfigurationError` naming the variable, which
 * fails startup.
 */
export function initServerConfig(): ServerConfig {
  config = parseEnvConfig(ServerConfigSchema, { clampLimits: 'EUPARL_CLAMP_LIMITS' });
  return config;
}

/**
 * Whether a `limit` above its collection cap clamps rather than failing validation. Read on
 * each `tools/list` emission and each call: `tool()` converts every input schema when its
 * definition module is imported, before `setup()` runs, so that conversion sees the defaults.
 */
export function clampLimits(): boolean {
  return (config ?? defaults).clampLimits;
}
