import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Field,
  Input,
} from '@git-stacks/ui'
import type { DesktopAPI, RepositorySnapshot } from '@git-stacks/shared/types'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'

/** Local registration needs no provider credentials and never converts or configures a repository. */
export function LocalRepositoryDialog({
  desktop,
  open,
  onOpenChange,
  onOpened,
  onClone,
}: {
  desktop: DesktopAPI
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpened: (snapshot: RepositorySnapshot) => Promise<void>
  onClone: () => void
}) {
  const recent = useQuery({
    queryKey: ['recent-repositories'],
    queryFn: () => desktop.recentRepositories(),
    enabled: open,
  })
  const [path, setPath] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const lock = React.useRef(false)
  const openPath = async (path?: string) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      if (path && !desktop.addRepository)
        throw new Error('Adding a repository path is unavailable in this runtime.')
      const result = path ? await desktop.addRepository!(path) : await desktop.openRepository()
      if (!result) {
        setError('Opening was cancelled; no repository was added.')
        return
      }
      await onOpened(result)
      onOpenChange(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!lock.current) onOpenChange(next)
      }}
    >
      <DialogContent className="wb-local-repository-dialog">
        <DialogHeader>
          <DialogTitle>Open a local repository</DialogTitle>
          <DialogDescription>
            Use an existing Git directory. Nothing is converted and no Git configuration is written.
            GitHub CLI and network access are not required.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (path.trim()) void openPath(path.trim())
          }}
        >
          <Field
            id="local-repository-path"
            label="Repository path"
            description="An absolute path to an existing repository or linked worktree."
          >
            <Input value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} />
          </Field>
          <div className="wb-list-toolbar">
            <Button type="submit" loading={busy} disabled={!path.trim()}>
              Open path
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void openPath()}>
              Choose folder
            </Button>
          </div>
        </form>
        {error || recent.error ? <p role="alert">{error ?? recent.error?.message}</p> : null}
        <section>
          <h2>Recent repositories</h2>
          <div className="wb-secondary-list">
            {recent.data?.slice(0, LIST_PAGE_SIZE).map((repo) => (
              <Button
                key={repo.path}
                variant="ghost"
                disabled={busy}
                onClick={() => void openPath(repo.path)}
              >
                <strong>{repo.name}</strong>
                <code>{repo.path}</code>
              </Button>
            ))}
            {!recent.data?.length ? (
              <p>
                {recent.isPending
                  ? 'Reading recent repositories…'
                  : 'No recent repositories recorded.'}
              </p>
            ) : null}
          </div>
        </section>
        <p className="wb-source-status">
          Folders may also be dropped onto the desktop window. A moved or missing folder remains an
          error, not a newly created repository.
        </p>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            onOpenChange(false)
            onClone()
          }}
        >
          Find and clone from GitHub instead
        </Button>
      </DialogContent>
    </Dialog>
  )
}
