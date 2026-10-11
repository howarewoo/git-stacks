import type { ChildProcess } from 'node:child_process'

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

export interface DesktopBenchmarkResult {
  startupMs: number
  interactionMs: number
}

export function freePort(): Promise<number>
export function pageTarget(
  port: number,
  child: ChildProcess,
  getError: () => string,
  pageOrigin: string,
): Promise<string>
export function connect(url: string): Promise<CdpClient>
export function evaluate(
  client: CdpClient,
  expression: string,
  awaitPromise?: boolean,
): Promise<unknown>
export function until(client: CdpClient, expression: string): Promise<void>
export function click(client: CdpClient, selector: string): Promise<void>
export function measureDesktop(repoRoot: string, fixture: string): Promise<DesktopBenchmarkResult>
