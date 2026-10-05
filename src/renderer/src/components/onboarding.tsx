import * as React from 'react'
import { Check, Copy, FolderOpen, LoaderCircle, Search, Terminal } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { SegmentedControl } from './ui/segmented-control'
import { EmptyState, InlineAlert, LoadingState } from './ui/surface'
import { OperationFacts, WorkflowSection, type ContextFact } from './workflow-composition'
import { createRequestGate } from '../lib/request-gate'
import type {
  CloneCommandPreview,
  CloneProtocol,
  GitEnvironmentStatus,
  GitHubCliStatus,
  GitHubRepositorySummary,
  OnboardingFailure,
  RepositoryCloneResult,
} from '../../../shared/types'

const SEARCH_REQUEST = 'onboarding:discovery'
const CLONE_REQUEST = 'onboarding:clone'

function environmentFacts(status: GitEnvironmentStatus): ContextFact[] {
  return [
    {
      label: 'Commit identity',
      value: status.identity.name
        ? `${status.identity.name} <${status.identity.email ?? 'no email'}>`
        : 'Not configured — Git will ask who to attribute commits to',
      code: true,
    },
    {
      label: 'Default branch',
      value: status.defaultBranch ?? 'Git’s own built-in default',
      code: true,
    },
    {
      label: 'HTTPS credentials',
      value: status.httpsCredentials.configured
        ? `Credential helper: ${status.httpsCredentials.helper ?? 'configured'}`
        : 'No credential helper — private HTTPS clones will not authenticate',
      code: true,
    },
    {
      label: 'SSH',
      value: status.ssh.available
        ? `ssh client on PATH${status.ssh.version ? ` (OpenSSH ${status.ssh.version})` : ''}`
        : 'No ssh client on PATH — SSH clones cannot connect',
      code: true,
    },
  ]
}

export function GitEnvironmentPanel({
  status,
  failure,
}: {
  status: GitEnvironmentStatus | null
  failure: OnboardingFailure | null
}) {
  return (
    <WorkflowSection label="This computer" className="onboarding-environment">
      {failure ? (
        <InlineAlert tone="warning">{failure.message}</InlineAlert>
      ) : status ? (
        <OperationFacts facts={environmentFacts(status)} />
      ) : (
        <LoadingState>Checking Git…</LoadingState>
      )}
    </WorkflowSection>
  )
}

function repositoryBadges(repository: GitHubRepositorySummary) {
  const badges: React.ReactNode[] = []
  if (repository.private) badges.push(<Badge key="private">Private</Badge>)
  if (repository.empty) badges.push(<Badge key="empty">Empty</Badge>)
  if (repository.archived) badges.push(<Badge key="archived">Archived</Badge>)
  if (repository.fork) badges.push(<Badge key="fork">Fork</Badge>)
  return badges
}

/**
 * A command the person can copy, with the copy confirmed in place. Every command
 * this app shows is presented rather than run: the renderer never composes one
 * from renderer input and never spawns a process for it.
 */
export function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="onboarding-command">
      <span className="onboarding-command-label">
        <Terminal aria-hidden="true" className="size-3.5" />
        {label}
      </span>
      <code className="onboarding-command-text">{command}</code>
      <Button
        aria-label={`Copy the ${label} command`}
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }}
        size="sm"
        type="button"
        variant="secondary"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} command copied` : ''}
      </span>
    </div>
  )
}

/**
 * Find a repository the authenticated CLI account can reach and clone it with
 * ordinary Git. The dialog names every refusal — a missing CLI, an account that
 * is not signed in, an organization that needs single sign-on, an unreachable
 * host, a destination that already holds files, a cancelled clone — and shows
 * the exact `git clone` and `gh repo clone` commands before anything is written.
 * Discovery needs the CLI; adding an existing local repository does not, so
 * that path stays available whatever this dialog reports.
 */
export function RepositoryDiscoveryDialog({
  authority,
  busy,
  cliStatus,
  onCloned,
  onOpenChange,
  onOpenCliStatus,
  open,
}: {
  /**
   * The CLI authority the account behind this window's GitHub belongs to: the
   * host, the state, the account, and the opaque credential generation.
   *
   * Everything this dialog finds is that account's to see, so a replacement
   * ends the search in flight and drops what it had already found — the rows,
   * the selection, and the clone commands composed for that selection — rather
   * than letting the next account be offered somebody else's private
   * repositories. The clone a person has already started is local Git writing
   * to their disk, so it is left to finish.
   */
  authority: string
  busy: boolean
  cliStatus: GitHubCliStatus | null
  onCloned: (result: RepositoryCloneResult) => void
  onOpenChange: (open: boolean) => void
  onOpenCliStatus: () => void
  open: boolean
}) {
  const desktop = window.desktop
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<GitHubRepositorySummary[]>([])
  const [searching, setSearching] = React.useState(false)
  const [searched, setSearched] = React.useState(false)
  const [discoveryFailure, setDiscoveryFailure] = React.useState<OnboardingFailure | null>(null)
  const [discoveryMeta, setDiscoveryMeta] = React.useState<{
    totalCount?: number
    truncated?: boolean
    incompleteResults?: boolean
  } | null>(null)
  const [selected, setSelected] = React.useState<GitHubRepositorySummary | null>(null)
  const [parentDirectory, setParentDirectory] = React.useState('')
  const [directoryName, setDirectoryName] = React.useState('')
  const [protocol, setProtocol] = React.useState<CloneProtocol>('https')
  const [shallow, setShallow] = React.useState(false)
  const [commands, setCommands] = React.useState<CloneCommandPreview | null>(null)
  const [commandFailure, setCommandFailure] = React.useState<OnboardingFailure | null>(null)
  const [cloning, setCloning] = React.useState(false)
  const [cloneFailure, setCloneFailure] = React.useState<OnboardingFailure | null>(null)

  // One discovery search at a time, and only the newest one may answer. A
  // search is a read of the account in effect when it was asked for, so a
  // replacement ends this claim: the answer that eventually arrives describes
  // what the previous account could reach and must not repopulate this list.
  const searchGate = React.useRef(createRequestGate()).current
  const search = React.useCallback(
    async (next: string) => {
      if (!desktop?.searchRepositories) return
      const claim = searchGate.claim()
      setSearching(true)
      setDiscoveryFailure(null)
      const outcome = await desktop.searchRepositories({ query: next, requestId: SEARCH_REQUEST })
      if (!searchGate.current(claim)) return
      setSearching(false)
      if (outcome.ok) {
        setResults(outcome.value.repositories)
        setDiscoveryMeta({
          totalCount: outcome.value.totalCount,
          truncated: outcome.value.truncated,
          incompleteResults: outcome.value.incompleteResults,
        })
        setSearched(true)
      } else if (outcome.failure.reason !== 'cancelled') {
        setDiscoveryFailure(outcome.failure)
        setResults([])
        setDiscoveryMeta(null)
        setSearched(true)
      }
    },
    [desktop, searchGate],
  )

  // A replaced authority takes the account's findings with it, whether or not
  // the dialog is on screen: what this account can reach is what the CLI
  // answered, so the rows, the selection, and the clone commands composed for
  // that selection are dropped rather than offered to the next account.
  //
  // What the person typed stays, because none of it came from the account: a
  // search term, a destination directory, a directory name, and the transport
  // and depth they chose are ordinary local Git, and a clone from an ordinary
  // Git URL keeps working with or without any CLI session. The same is true of
  // a clone already running: it is Git writing to the person's own disk, so it
  // is left to finish.
  React.useEffect(() => {
    searchGate.reset()
    void desktop?.cancel?.(SEARCH_REQUEST)
    // The search in flight belongs to the retired account and will never
    // publish, so its flag ends with it rather than leaving the field spinning
    // for an answer this window has already refused.
    setSearching(false)
    setResults([])
    setSelected(null)
    setCommands(null)
    setCommandFailure(null)
    setDiscoveryMeta(null)
    setDiscoveryFailure(null)
    setSearched(false)
  }, [authority, desktop, searchGate])

  // Listing what the account can reach is the first thing this dialog shows,
  // and it is asked again whenever the account behind it changes: what this
  // window can offer to clone is the new account's to offer, not the previous
  // one's, and the re-read is what proves the window knows the difference.
  React.useEffect(() => {
    if (!open || !desktop?.searchRepositories) return
    void search('')
  }, [authority, desktop, open, search])

  // The commands are recomputed by the main process, which owns the only code
  // that can build them, so the copy is exactly what a clone would run.
  React.useEffect(() => {
    if (!open || !selected || !parentDirectory || !directoryName) {
      setCommands(null)
      setCommandFailure(null)
      return
    }
    let current = true
    desktop
      ?.previewCloneCommand?.({
        repository: selected,
        protocol,
        parentDirectory,
        directoryName,
        shallow,
      })
      .then((outcome) => {
        if (!current) return
        if (outcome.ok) {
          setCommands(outcome.value)
          setCommandFailure(null)
        } else {
          setCommands(null)
          setCommandFailure(outcome.failure)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [desktop, directoryName, open, parentDirectory, protocol, selected, shallow])

  const startClone = async () => {
    if (!desktop?.cloneRepository || !selected || !parentDirectory || !directoryName) return
    setCloning(true)
    setCloneFailure(null)
    const outcome = await desktop.cloneRepository({
      repository: selected,
      protocol,
      parentDirectory,
      directoryName,
      shallow,
      requestId: CLONE_REQUEST,
    })
    setCloning(false)
    if (outcome.ok) {
      onCloned(outcome.value)
      onOpenChange(false)
      return
    }
    setCloneFailure(outcome.failure)
  }

  // Discovery reads GitHub as the authenticated CLI account; which of the
  // distinct states that is decides whether an empty result is a fact about the
  // account or a fact about this computer, and each reads as its own thing.
  const authenticated = cliStatus?.state === 'authenticated'
  const destinationReady = Boolean(parentDirectory && directoryName && commands)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape and a backdrop click never abandon a running clone.
        if (!next && (cloning || busy)) return
        if (!next) setCloneFailure(null)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="workflow-dialog max-w-3xl"
        onEscapeKeyDown={(event) => cloning && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>
            Git Stacks clones with ordinary Git, using the GitHub CLI account for this host to find
            the repository. The clone itself is standard Git and keeps working in your terminal,
            your editor, and GitHub Desktop.
          </DialogDescription>
        </DialogHeader>

        <div className="onboarding-discovery">
          <form
            className="onboarding-search"
            onSubmit={(event) => {
              event.preventDefault()
              void search(query)
            }}
          >
            <Field id="repository-search" label="Search your repositories">
              <Input
                autoComplete="off"
                id="repository-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, owner, or description"
                value={query}
              />
            </Field>
            <Button disabled={searching} type="submit" variant="accent">
              {searching ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Search aria-hidden="true" className="size-4" />
              )}
              Search
            </Button>
            {searching ? (
              <Button
                onClick={() => void desktop?.cancel(SEARCH_REQUEST)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            ) : null}
          </form>

          {discoveryFailure ? (
            <InlineAlert tone={discoveryFailure.reason === 'sso-denied' ? 'warning' : 'error'}>
              {discoveryFailure.message}
              {/* Search is the one onboarding path that needs GitHub, so an
                  authentication refusal is the one that opens the CLI status.
                  Adding an existing local repository is offered outside this
                  dialog and is never gated on it. */}
              {discoveryFailure.reason === 'signed-out' ||
              discoveryFailure.reason === 'authentication' ||
              discoveryFailure.reason === 'unavailable' ? (
                <Button className="mt-2" onClick={onOpenCliStatus} size="sm" variant="secondary">
                  Open GitHub CLI status
                </Button>
              ) : null}
            </InlineAlert>
          ) : null}

          {searching && !results.length ? <LoadingState>Loading repositories…</LoadingState> : null}

          {searched && !results.length && !discoveryFailure ? (
            <EmptyState>
              <strong>No repositories to show</strong>
              <span>
                {authenticated
                  ? 'This GitHub CLI account reached nothing by that name. Search for another name, or check which account is signed in.'
                  : cliStatus?.state === 'missing-cli'
                    ? 'Searching GitHub needs the GitHub CLI. Install it and sign in for this host, then search again — or add a local repository instead.'
                    : cliStatus
                      ? 'Sign in with the GitHub CLI for this host to search the repositories you can reach.'
                      : 'This window has not read the GitHub CLI status yet, so it cannot say whose repositories this is. Check the GitHub CLI status, then search again.'}
              </span>
            </EmptyState>
          ) : null}

          {discoveryMeta?.incompleteResults ? (
            <InlineAlert tone="warning">
              GitHub returned partial results because the search timed out. Refine your query for
              more.
            </InlineAlert>
          ) : null}

          {discoveryMeta?.truncated && discoveryMeta.totalCount ? (
            <p className="onboarding-hint">
              Showing the first {results.length} of {discoveryMeta.totalCount} repositories. Refine
              your search to narrow the list.
            </p>
          ) : null}

          {results.length > 0 ? (
            <ul aria-label="Repositories you can reach" className="onboarding-results">
              {results.map((repository) => (
                <li key={repository.fullName}>
                  <button
                    aria-pressed={selected?.fullName === repository.fullName}
                    className="onboarding-result"
                    onClick={() => {
                      setSelected(repository)
                      setDirectoryName(repository.name)
                      setCloneFailure(null)
                    }}
                    type="button"
                  >
                    <span className="onboarding-result-name">{repository.fullName}</span>
                    {repository.description ? (
                      <span className="onboarding-result-description">
                        {repository.description}
                      </span>
                    ) : null}
                    <span className="onboarding-result-meta">
                      {repositoryBadges(repository)}
                      <Badge variant="outline">{repository.defaultBranch}</Badge>
                      {!repository.canPush ? <Badge variant="outline">Read only</Badge> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {selected ? (
          <div className="onboarding-clone">
            <WorkflowSection label={`Clone ${selected.fullName}`}>
              {selected.empty ? (
                <InlineAlert tone="info">
                  This repository has no commits yet. The clone succeeds and your first branch
                  starts from nothing.
                </InlineAlert>
              ) : null}
              <div className="onboarding-clone-grid">
                <div className="grid gap-1.5">
                  <label
                    className="text-[length:var(--gs-semantic-type-label-size)] font-medium text-[var(--gs-semantic-text-primary)]"
                    htmlFor="clone-folder"
                  >
                    Folder
                  </label>
                  <div className="onboarding-folder">
                    <Input
                      aria-describedby="clone-folder-description"
                      id="clone-folder"
                      onChange={(event) => setDirectoryName(event.target.value)}
                      value={directoryName}
                    />
                    <Button
                      disabled={cloning}
                      onClick={async () => {
                        const chosen = await desktop?.chooseDestinationDirectory?.(parentDirectory)
                        if (chosen) setParentDirectory(chosen)
                      }}
                      type="button"
                      variant="secondary"
                    >
                      <FolderOpen aria-hidden="true" className="size-4" />
                      Choose folder
                    </Button>
                  </div>
                  <p
                    className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]"
                    id="clone-folder-description"
                  >
                    {parentDirectory || 'Choose where the repository folder is created.'}
                  </p>
                </div>
                <Field id="clone-protocol" label="Protocol">
                  <SegmentedControl
                    label="Protocol"
                    onValueChange={(value) => setProtocol(value)}
                    options={[
                      { value: 'https', label: 'HTTPS' },
                      { value: 'ssh', label: 'SSH' },
                    ]}
                    value={protocol}
                  />
                </Field>
              </div>
              <Checkbox
                checked={shallow}
                description="Only the most recent commit, for a faster first clone."
                disabled={cloning}
                label="Shallow clone (--depth 1)"
                onChange={(event) => setShallow(event.target.checked)}
              />
              {commandFailure ? (
                <InlineAlert tone="warning">{commandFailure.message}</InlineAlert>
              ) : null}
              {commands ? (
                <div className="onboarding-commands">
                  <CopyableCommand command={commands.gitCommand} label="git clone" />
                  <CopyableCommand command={commands.ghCommand} label="gh repo clone" />
                </div>
              ) : null}
            </WorkflowSection>

            {cloneFailure ? (
              <InlineAlert tone="error" role="alert">
                {cloneFailure.message}
              </InlineAlert>
            ) : null}

            <div className="onboarding-clone-actions">
              {cloning ? (
                <Button
                  onClick={() => void desktop?.cancel(CLONE_REQUEST)}
                  type="button"
                  variant="secondary"
                >
                  Cancel clone
                </Button>
              ) : (
                <Button
                  disabled={!destinationReady}
                  onClick={() => void startClone()}
                  type="button"
                  variant="accent"
                >
                  <FolderOpen aria-hidden="true" className="size-4" />
                  Clone repository
                </Button>
              )}
              {!parentDirectory && !cloning ? (
                <span className="onboarding-hint">Choose the folder to clone into.</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
