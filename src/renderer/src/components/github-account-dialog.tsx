import * as React from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { InlineAlert } from './ui/surface'
import { WorkflowSection } from './workflow-composition'
import type { GitHubAccountState, GitHubAccountStatus } from '../../../shared/types'

const STATE_TITLES: Record<GitHubAccountState, string> = {
  'not-configured': 'Not configured',
  'signed-out': 'Signed out',
  'signing-in': 'Waiting for authorization',
  'signed-in': 'Signed in',
  expired: 'Sign-in expired',
  revoked: 'Authorization revoked',
  'permission-denied': 'Organization authorization required',
  offline: 'GitHub unreachable',
  'storage-unavailable': 'No secure credential store',
}

type Tone = 'info' | 'success' | 'warning' | 'error'

const STATE_TONES: Record<GitHubAccountState, Tone> = {
  'not-configured': 'warning',
  'signed-out': 'info',
  'signing-in': 'info',
  'signed-in': 'success',
  expired: 'warning',
  revoked: 'error',
  'permission-denied': 'error',
  offline: 'warning',
  'storage-unavailable': 'error',
}

const BADGE_TONES: Record<Tone, 'info' | 'success' | 'warning' | 'danger'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
}

function when(timestamp: number | null): string | null {
  if (timestamp === null) return null
  return new Date(timestamp).toLocaleString()
}

/**
 * Account status, the permissions the registered app asks for, and the one
 * sign-in flow. Everything here is a status: the credential itself is sealed by
 * the operating system and never reaches this window.
 */
export function GitHubAccountDialog({
  busy,
  onOpenChange,
  onSignIn,
  onSignOut,
  onCancelSignIn,
  onOpenVerification,
  open,
  status,
}: {
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSignIn: () => void
  onSignOut: () => void
  onCancelSignIn: () => void
  onOpenVerification: () => void
  open: boolean
  status: GitHubAccountStatus | null
}) {
  const state = status?.state ?? 'signed-out'
  const signedIn = state === 'signed-in'
  const canSignIn =
    !busy &&
    status?.store.available === true &&
    state !== 'signing-in' &&
    state !== 'not-configured'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-dialog" aria-label="GitHub account">
        <DialogHeader>
          <DialogTitle>GitHub account</DialogTitle>
          <DialogDescription>
            Sign in with the GitHub App so pull requests, stacks, and reviews load without the
            GitHub CLI installed. Your credential is sealed by this computer&rsquo;s own key store
            and never reaches this window.
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-form">
          <WorkflowSection label="Status">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={BADGE_TONES[STATE_TONES[state]]}>{STATE_TITLES[state]}</Badge>
              {status?.login ? <Badge variant="outline">{status.login}</Badge> : null}
              {status?.host ? <Badge variant="outline">{status.host}</Badge> : null}
            </div>
            {status?.message ? (
              <InlineAlert tone={STATE_TONES[state]}>{status.message}</InlineAlert>
            ) : null}
            {status?.externalCredential ? (
              <InlineAlert tone="info" title="An environment credential takes priority">
                This build is using a credential supplied by the environment. Sign in to use the
                credential this application owns instead.
              </InlineAlert>
            ) : null}
          </WorkflowSection>

          {state === 'signing-in' ? (
            <WorkflowSection label="One-time code">
              {status?.challenge ? (
                <>
                  <p className="m-0 text-[length:var(--gs-semantic-type-body-size)]">
                    Open GitHub&rsquo;s device page, enter this code, and authorize the app. The
                    code expires {when(status.challenge.expiresAt)}.
                  </p>
                  <p className="m-0 font-mono text-[length:var(--gs-semantic-type-metadata-size)]">
                    {status.challenge.userCode}
                  </p>
                </>
              ) : (
                <p className="m-0 text-[length:var(--gs-semantic-type-body-size)]">
                  Asking GitHub for a one-time code.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {/* Never disabled and shown before the code exists: a sign-in
                    waiting on GitHub is exactly the case to be able to abandon. */}
                {status?.challenge ? (
                  <Button onClick={onOpenVerification} size="sm">
                    Open device page
                  </Button>
                ) : null}
                <Button onClick={onCancelSignIn} size="sm" variant="secondary">
                  Cancel sign-in
                </Button>
              </div>
            </WorkflowSection>
          ) : null}

          <WorkflowSection label="Credential">
            <dl className="m-0 grid gap-1 text-[length:var(--gs-semantic-type-metadata-size)]">
              <div className="flex gap-2">
                <dt className="text-[var(--gs-semantic-text-secondary)]">Stored by</dt>
                <dd className="m-0">
                  {status?.store.available
                    ? (status.store.name ?? 'Operating-system key store')
                    : (status?.store.reason ?? 'No key store available.')}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-[var(--gs-semantic-text-secondary)]">Access expires</dt>
                <dd className="m-0">{when(status?.expiresAt ?? null) ?? 'No expiry'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-[var(--gs-semantic-text-secondary)]">Renewal expires</dt>
                <dd className="m-0">{when(status?.refreshExpiresAt ?? null) ?? 'No renewal'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-[var(--gs-semantic-text-secondary)]">Reference</dt>
                <dd className="m-0 font-mono">
                  {status?.reference ? `${status.reference.slice(0, 8)}…` : 'None'}
                </dd>
              </div>
            </dl>
            <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
              Only this opaque reference is written to application state. The credential itself
              stays in {status?.store.available ? 'the operating-system key store' : 'no store'}.
            </p>
          </WorkflowSection>

          <WorkflowSection label="Requested permissions">
            <ul className="m-0 grid list-none gap-1 p-0 text-[length:var(--gs-semantic-type-metadata-size)]">
              {(status?.permissions ?? []).map((permission) => (
                <li className="flex flex-wrap items-center gap-2" key={permission.permission}>
                  <Badge variant={permission.access === 'write' ? 'warning' : 'secondary'}>
                    {permission.permission}: {permission.access}
                  </Badge>
                  <span className="text-[var(--gs-semantic-text-secondary)]">
                    {permission.feature}
                  </span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
              GitHub App user sign-ins do not request OAuth scopes. These fine-grained permissions
              belong to the app registration, and Git Stacks asks for none of notifications,
              projects, or workflows.
            </p>
          </WorkflowSection>

          <div className="flex flex-wrap gap-2">
            <Button disabled={!canSignIn} loading={state === 'signing-in'} onClick={onSignIn}>
              {signedIn ? 'Sign in again' : 'Sign in to GitHub'}
            </Button>
            <Button
              disabled={!status?.reference && state !== 'signing-in'}
              onClick={onSignOut}
              variant="secondary"
            >
              Sign out
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
