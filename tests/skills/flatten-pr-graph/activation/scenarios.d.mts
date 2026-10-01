/**
 * Types for `scenarios.mjs`, the activation contract shared by the probe and the
 * deterministic gate. Declared beside the module so neither consumer has to restate it.
 */

export type Activation = 'must-load' | 'must-not-load' | 'consult-then-decline'

export interface Scenario {
  id: string
  /** The case this scenario exists to cover, named so a dropped case is visible. */
  covers: string
  request: string
  expect: { activation: Activation; writes: 'never' | 'allowed' }
  /** Only for cases where the observable is what the agent said, never what it did. */
  mustAskFor?: RegExp
  mustAskWhy?: string
}

export interface ToolCall {
  name: string
  input?: Record<string, unknown>
}

export interface ClassifiedCall {
  name: string
  command: string
  target: string
  skillRead: boolean
  mutating: boolean
  forbidden: boolean
  isCheck: boolean
}

export interface JudgedTrace {
  skillRead: boolean
  skillUriReads: string[]
  writeAttempts: string[]
  forbiddenAttempts: string[]
  checkCommands: string[]
  toolCallCount: number
  problems: string[]
}

export declare const FORBIDDEN_COMMAND: RegExp
export declare const CHECK_COMMAND: RegExp
export declare const MUTATING_TOOL: RegExp
export declare const HARNESS_REPORT_DEVICE: RegExp
export declare const MUTATING_COMMAND: RegExp
export declare const SCENARIOS: Scenario[]
export declare const FIXTURE_METADATA: {
  repository: string
  defaultBranch: string
  pullRequests: Array<{ number: number; title: string; base: string; head: string }>
}
export declare function isSkillRead(target: string): boolean
export declare function classifyToolCall(call: ToolCall): ClassifiedCall
export declare function judgeTrace(calls: ClassifiedCall[], scenario: Scenario): JudgedTrace
