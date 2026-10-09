import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { InlineAlert } from './ui/surface'
import { OperationFacts, WorkflowSection, type ContextFact } from './workflow-composition'
import { CopyableCommand } from './onboarding'
import type { GitHubCliState, GitHubCliStatus } from '@git-stacks/shared/types'

/**
 * The only address this surface names for installing the CLI. It is shown as
 * text the person copies or reads, never opened through the app's external-link
 * boundary, which only carries GitHub hosts this installation already speaks to.
 */
export const GITHUB_CLI_INSTALL_URL = 'https://cli.github.com/'

type Tone = 'info' | 'success' | 'warning' | 'error'

const STATE_TITLES: Record<GitHubCliState, string> = {
  checking: 'Checking the GitHub CLI',
  'missing-cli': 'GitHub CLI not installed',
  'signed-out': 'Not signed in',
  authenticated: 'Signed in to GitHub',
  rejected: 'GitHub refused this authentication',
  'permission-denied': 'Organization authorization required',
  offline: 'GitHub unreachable',
  unavailable: 'GitHub CLI could not be run',
}

const STATE_TONES: Record<GitHubCliState, Tone> = {
  checking: 'info',
  'missing-cli': 'warning',
  'signed-out': 'warning',
  authenticated: 'success',
  rejected: 'error',
  'permission-denied': 'error',
  offline: 'warning',
  unavailable: 'error',
}

/**
 * The commands that establish, inspect, or change the CLI session for this
 * host, in the order a person needs them. They are fixed and host-scoped: the
 * window composes a command from the host the status names and nothing else, and
 * it never runs one.
 *
 * A login command appears only for the two states in which there is no usable
 * account: nobody signed in, or a credential the CLI has that the host refused.
 * A CLI that could not be read, a host that did not answer, and an account the
 * host does not authorize are not sign-out states — the session is untouched in
 * all three, and offering a login would invite a person to replace a credential
 * that may still be the right one. Those states are given the command that
 * reports the truth instead, and the fixed guidance beside them says what to do.
 */
function cliCommands(status: GitHubCliStatus | null): { label: string; command: string }[] {
  const host = status?.host || 'github.com'
  const commands: { label: string; command: string }[] = []
  if (status?.state === 'missing-cli') {
    commands.push({ label: 'Verify the install', command: 'gh --version' })
    return commands
  }
  commands.push({
    label: 'Check the current session',
    command: `gh auth status --hostname ${host}`,
  })
  if (status?.state === 'signed-out' || status?.state === 'rejected') {
    commands.push({
      label: status.state === 'rejected' ? 'Sign in again' : 'Sign in',
      command: `gh auth login --hostname ${host} --web`,
    })
    return commands
  }
  if (status?.state !== 'authenticated') {
    // Checking, offline, unauthorized for the organization, or simply unreadable:
    // the session this host has is not in question, so nothing about it changes
    // here and the only command offered is the one that reads it.
    return commands
  }
  // Switching is the CLI's own decision about which of its accounts is active,
  // so the command names no account: `gh auth switch --user` for the account
  // already in use is a no-op, and this surface never ends a session.
  commands.push({ label: 'Switch account', command: `gh auth switch --hostname ${host}` })
  if (status.login) {
    commands.push({
      label: 'Sign out',
      command: `gh auth logout --hostname ${host} --user ${status.login}`,
    })
  }
  return commands
}

/**
 * What was measured on this computer, reported apart from one another: the CLI's
 * own version is not authentication, and an account name is not proof that this
 * host accepted it. Every value here is sanitized status the main process read;
 * no credential, credential path, or raw CLI output reaches this surface.
 */
function cliStatusFacts(status: GitHubCliStatus | null): ContextFact[] {
  const state: GitHubCliState = status?.state ?? 'checking'
  return [
    { label: 'Authentication', value: STATE_TITLES[state] },
    { label: 'Host', value: status?.host || 'github.com', code: true },
    { label: 'GitHub account', value: status?.login ?? 'None reported' },
    { label: 'GitHub CLI version', value: status?.version ?? 'Not detected', code: true },
  ]
}

/**
 * The status surface that replaces the account panel: what the required provider
 * CLI is doing for this host, and what the person can run in their own terminal.
 * Refreshing is a real read. Nothing here installs software, signs in, switches
 * accounts, or signs out on the CLI's behalf.
 */
export function GitHubCliStatusSection({
  onRefresh,
  refreshing,
  status,
}: {
  onRefresh: () => void
  refreshing: boolean
  status: GitHubCliStatus | null
}) {
  const state: GitHubCliState = status?.state ?? 'checking'
  return (
    <WorkflowSection label="GitHub CLI">
      <OperationFacts facts={cliStatusFacts(status)} />
      {status?.message ? (
        <InlineAlert tone={STATE_TONES[state]}>{status.message}</InlineAlert>
      ) : null}
      {status?.state === 'missing-cli' ? (
        <InlineAlert tone="info" title="Installing the CLI is your action">
          Git Stacks does not install software and never launches a login on its own. Open{' '}
          <span className="font-mono">{GITHUB_CLI_INSTALL_URL}</span> in your browser, install{' '}
          <span className="font-mono">gh</span>, then refresh this status.
        </InlineAlert>
      ) : null}
      <div className="grid gap-2">
        {cliCommands(status).map((command) => (
          <CopyableCommand key={command.label} label={command.label} command={command.command} />
        ))}
      </div>
      <p className="m-0 text-[length:var(--gs-semantic-type-body-size)] leading-[var(--gs-semantic-type-body-line)] text-[var(--gs-semantic-text-secondary)]">
        The GitHub CLI owns sign-in, credential storage, account switching, and sign-out. These
        commands are shown for you to run in a terminal; this window never runs them, and opening,
        refreshing, or closing it changes nothing in the CLI session. Local Git — staging,
        committing, branching, and recovery — works with or without it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={refreshing} onClick={onRefresh} size="sm" variant="secondary">
          <RefreshCw
            aria-hidden="true"
            className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'}
          />
          {refreshing ? 'Refreshing…' : 'Refresh status'}
        </Button>
      </div>
    </WorkflowSection>
  )
}

/**
 * The sidebar status dialog uses the same measured facts and terminal guidance
 * as Settings, without repeating the session in a second status block.
 */
export function GitHubCliStatusDialog({
  onOpenChange,
  onRefresh,
  open,
  refreshing,
  status,
}: {
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  open: boolean
  refreshing: boolean
  status: GitHubCliStatus | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog" aria-label="GitHub CLI status">
        <DialogHeader>
          <DialogTitle>GitHub CLI authentication</DialogTitle>
          <DialogDescription>
            Git Stacks reads GitHub through the GitHub CLI installed on this computer. This window
            reports the session it found.
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-form">
          <GitHubCliStatusSection onRefresh={onRefresh} refreshing={refreshing} status={status} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
