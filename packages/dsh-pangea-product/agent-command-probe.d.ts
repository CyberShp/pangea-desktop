export interface ResolvedAgentCommand {
  command: string
  version?: string
  versionError?: string
}

export type PowerShellProbeRunner = (command: string, environment: NodeJS.ProcessEnv) => string

export class AgentCommandResolutionError extends Error {
  readonly status: 'not_found' | 'probe_error'
  constructor(message: string, status: 'not_found' | 'probe_error')
}

export function runAgentCommandPowerShellProbe(command: string, environment: NodeJS.ProcessEnv): string
export function resolveAgentCommandWithPowerShell(
  command: string,
  environment: NodeJS.ProcessEnv,
  runProbe?: PowerShellProbeRunner
): ResolvedAgentCommand
