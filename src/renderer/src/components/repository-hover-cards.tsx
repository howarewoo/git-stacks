import * as React from 'react'
import type { ReactElement } from 'react'
import type { Branch, PullRequest } from '../../../shared/types'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'

const ActiveCard = React.createContext<{
  id: string | null
  setId: React.Dispatch<React.SetStateAction<string | null>>
} | null>(null)

export function RepositoryHoverCardProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = React.useState<string | null>(null)
  const value = React.useMemo(() => ({ id, setId }), [id])
  return <ActiveCard.Provider value={value}>{children}</ActiveCard.Provider>
}

function RepositoryHoverCard({
  trigger,
  children,
  openDelay,
}: {
  trigger: ReactElement
  children: React.ReactNode
  openDelay: number
}) {
  const active = React.useContext(ActiveCard)
  const id = React.useId()
  const triggerRef = React.useRef<React.ElementRef<typeof HoverCardTrigger>>(null)
  if (!active) throw new Error('Repository hover cards require their provider')
  return (
    <HoverCard
      openDelay={openDelay}
      closeDelay={150}
      open={active.id === id}
      onOpenChange={(open) => {
        // A delayed open must not outlive the interaction that scheduled it.
        if (open && !triggerRef.current?.matches(':hover, :focus-within')) return
        active.setId((current) => (open ? id : current === id ? null : current))
      }}
    >
      <HoverCardTrigger ref={triggerRef} asChild>
        {trigger}
      </HoverCardTrigger>
      {children}
    </HoverCard>
  )
}

function ContextRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
      <dt className="text-[var(--gs-semantic-text-secondary)]">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

export function BranchHoverCard({ branch, children }: { branch: Branch; children: ReactElement }) {
  return (
    <RepositoryHoverCard trigger={children} openDelay={650}>
      <HoverCardContent>
        <strong className="block">{branch.name}</strong>
        <p className="mt-1 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
          {branch.current ? 'Current branch' : branch.remote ? 'Remote branch' : 'Local branch'}
        </p>
        <p className="my-3 leading-relaxed">{branch.subject || 'No commit subject'}</p>
        <dl className="space-y-2 text-xs">
          <ContextRow label="Parent">{branch.parent ?? 'No stack parent'}</ContextRow>
          <ContextRow label="Upstream">
            {branch.upstream ?? 'Not tracking a remote branch'}
          </ContextRow>
          {branch.upstream ? (
            <ContextRow label="Sync">
              {branch.ahead} ahead · {branch.behind} behind
            </ContextRow>
          ) : null}
          {branch.oid ? (
            <ContextRow label="Commit">
              <code>{branch.oid.slice(0, 12)}</code>
            </ContextRow>
          ) : null}
        </dl>
        {branch.needsRestack ? (
          <p className="mt-3 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-feedback-warning-text)]">
            The parent or recorded boundary changed. Review a restack before publishing.
          </p>
        ) : null}
      </HoverCardContent>
    </RepositoryHoverCard>
  )
}

export function PullRequestHoverCard({
  pr,
  children,
}: {
  pr: PullRequest
  children: ReactElement
}) {
  return (
    <RepositoryHoverCard trigger={children} openDelay={500}>
      <HoverCardContent>
        <p className="mb-1 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
          Pull request #{pr.number} ·{' '}
          {pr.state === 'OPEN' && pr.draft ? 'draft' : pr.state.toLowerCase()}
        </p>
        <strong className="block leading-snug">{pr.title}</strong>
        <p className="my-3 text-[length:var(--gs-semantic-type-metadata-size)]">
          <span>{pr.head}</span> → <span>{pr.base}</span>
        </p>
        <dl className="space-y-2 text-xs">
          <ContextRow label="Checks">
            {pr.checks === 'none' ? 'No checks reported' : pr.checks}
          </ContextRow>
          <ContextRow label="Review">
            {pr.reviewDecision?.replaceAll('_', ' ').toLowerCase() || 'No review decision'}
          </ContextRow>
          <ContextRow label="Merge state">
            {pr.mergeState?.replaceAll('_', ' ').toLowerCase() || 'Not reported by GitHub'}
          </ContextRow>
        </dl>
        <p className="mt-3 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
          GitHub rules and the reviewed head are checked again before merging.
        </p>
      </HoverCardContent>
    </RepositoryHoverCard>
  )
}
