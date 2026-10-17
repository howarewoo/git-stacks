import type { NativeStack, PullRequest } from './types'
export type NativeOperationRequest =
  | { kind: 'create'; pullRequests: number[] }
  | { kind: 'extend'; stackNumber: number; pullRequests: number[] }
  | { kind: 'unstack'; stackNumber: number }
export interface NativeOperationPreview {
  token: string
  request: NativeOperationRequest
  fullName: string
  pullRequests: PullRequest[]
  stack: NativeStack | null
  blockers: string[]
  effects: string[]
}
