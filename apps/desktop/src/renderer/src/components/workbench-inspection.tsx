import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Select } from '@git-stacks/ui'
import type { DesktopAPI } from '@git-stacks/shared/types'
import type { InspectionWorktreeStatus } from '@git-stacks/shared/inspection'
import { LIST_PAGE_SIZE, DIFF_PAGE_SIZE } from '@git-stacks/shared/performance'
import { checkStateLabel, checkRequirementLabel } from '../lib/pull-request-state'

function ReadStatus({ loading, error }: { loading: boolean; error: Error | null }) {
  return loading ? (
    <p role="status">Reading selected context…</p>
  ) : error ? (
    <p role="alert">{error.message}</p>
  ) : null
}
function CodePage({ text, label }: { text: string; label: string }) {
  const [page, setPage] = useState(0)
  const lines = text.split('\n')
  useEffect(() => setPage(0), [text])
  const pages = Math.max(1, Math.ceil(lines.length / DIFF_PAGE_SIZE))
  return (
    <section className="bw-section">
      <h3>{label}</h3>
      <pre className="wb-code" tabIndex={0} aria-label={label}>
        {lines.slice(page * DIFF_PAGE_SIZE, (page + 1) * DIFF_PAGE_SIZE).join('\n')}
      </pre>
      {pages > 1 ? (
        <div className="bw-between">
          <Button size="xs" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous lines
          </Button>
          <span>
            Page {page + 1} / {pages}
          </span>
          <Button size="xs" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next lines
          </Button>
        </div>
      ) : null}
    </section>
  )
}
export function LocalInspection({
  api,
  identity,
  revision,
  snapshot,
  loading,
  error,
}: {
  api: DesktopAPI
  identity: string
  revision: string
  snapshot: InspectionWorktreeStatus | undefined
  loading: boolean
  error: Error | null
}) {
  const [filePage, setFilePage] = useState(0)
  const [path, setPath] = useState<string | null>(null)
  const files = snapshot?.files ?? []
  const selected = files.find((entry) => entry.path === path)
  const file = useQuery({
    queryKey: ['inspection-file', identity, revision, snapshot?.headOid, path],
    enabled: Boolean(path && selected),
    queryFn: async ({ signal }) => {
      const cancel = () => void api.cancel(`file:${path}`)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await api.fileView(path!)
        signal.throwIfAborted()
        return result
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const conflict = useQuery({
    queryKey: ['inspection-conflict', identity, revision, snapshot?.headOid, path],
    enabled: Boolean(path && selected?.conflicted),
    queryFn: async ({ signal }) => {
      const cancel = () => void api.cancel(`conflict:${path}`)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await api.conflictView(path!)
        signal.throwIfAborted()
        return result
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  useEffect(() => {
    setPath(null)
    setFilePage(0)
  }, [identity])
  const pages = Math.max(1, Math.ceil(files.length / LIST_PAGE_SIZE))
  useEffect(() => setFilePage((value) => Math.min(value, pages - 1)), [pages])
  return (
    <div>
      <ReadStatus loading={loading} error={error} />
      {snapshot ? (
        <>
          <p>
            <code>{snapshot.path}</code>
          </p>
          <p>
            Actual local HEAD: <code>{snapshot.headOid ?? 'Unborn / unknown'}</code> ·{' '}
            {snapshot.currentBranch ?? 'Detached HEAD'}
          </p>
          <p>
            Status observed at {snapshot.observedAt}. Read-only HEAD → index → working directory;
            this is an observation, not a frozen comparison. External conflict resolution does not
            stage or continue an operation.
          </p>
          {snapshot.filesTruncated ? (
            <p role="status">File inventory truncated; listed files are a lower bound.</p>
          ) : null}
          <Select
            aria-label="Local file to inspect"
            value={path ?? ''}
            onValueChange={(value) => setPath(String(value))}
            options={files
              .slice(filePage * LIST_PAGE_SIZE, (filePage + 1) * LIST_PAGE_SIZE)
              .map((entry) => ({
                value: entry.path,
                label: `${entry.conflicted ? 'Conflict' : entry.index === '?' ? 'Untracked' : `Index ${entry.index} / directory ${entry.worktree}`} · ${entry.originalPath ? `${entry.originalPath} → ` : ''}${entry.path}`,
              }))}
          />
          {pages > 1 ? (
            <div className="bw-between">
              <Button
                disabled={!filePage}
                onClick={() => {
                  setFilePage(filePage - 1)
                  setPath(null)
                }}
              >
                Previous files
              </Button>
              <span>
                Files page {filePage + 1} / {pages}
              </span>
              <Button
                disabled={filePage + 1 >= pages}
                onClick={() => {
                  setFilePage(filePage + 1)
                  setPath(null)
                }}
              >
                Next files
              </Button>
            </div>
          ) : null}
          {!files.length && !snapshot.filesTruncated ? (
            <p>No local changes were observed in this directory.</p>
          ) : null}
          {selected?.sparseExcluded ? (
            <p>Sparse-excluded path; not materialized in this directory.</p>
          ) : null}
          <ReadStatus loading={file.isFetching} error={file.error} />
          {path && !selected ? (
            <p>
              The selected path no longer appears in this directory's status. Choose a current path.
            </p>
          ) : file.data ? (
            <>
              <p>
                Selected file comparison fingerprint: <code>{file.data.fingerprint}</code>
              </p>
              {file.data.binary ? <p>Binary file: textual diff unavailable.</p> : null}
              {file.data.submodule ? (
                <p>Submodule gitlink: only recorded commit differences are shown.</p>
              ) : null}
              {file.data.lfs ? (
                <p>Git LFS pointer; the object is not rendered as ordinary source.</p>
              ) : null}
              {file.data.truncated ? (
                <p role="status">Read truncated at the canonical byte limit.</p>
              ) : null}
              {file.data.conflicted ? (
                <p>Conflicted local path. This viewer performs no resolution or staging.</p>
              ) : null}
              {file.data.stagedDiff ? (
                <CodePage text={file.data.stagedDiff} label="Staged · HEAD compared with index" />
              ) : null}
              {file.data.unstagedDiff ? (
                <CodePage
                  text={file.data.unstagedDiff}
                  label="Unstaged · index compared with directory"
                />
              ) : null}
              {!file.data.conflicted &&
              !file.data.stagedDiff &&
              !file.data.unstagedDiff &&
              file.data.content !== null ? (
                <CodePage
                  text={file.data.content}
                  label={
                    selected?.index === '?'
                      ? 'Untracked directory content'
                      : 'Current directory content'
                  }
                />
              ) : null}
            </>
          ) : null}
          {selected?.conflicted ? (
            <>
              <ReadStatus loading={conflict.isFetching} error={conflict.error} />
              {conflict.data ? (
                <>
                  <p>
                    {conflict.data.labels.explanation} · {conflict.data.kind}
                  </p>
                  <p>
                    Index stages: {conflict.data.stages.join(', ') || 'None'} · fingerprint{' '}
                    <code>{conflict.data.fingerprint}</code>
                  </p>
                  {conflict.data.truncated ? (
                    <p>Conflict content truncated at the canonical preview limit.</p>
                  ) : null}
                  {conflict.data.binary ? (
                    <p>Binary conflict; text resolution is unavailable.</p>
                  ) : null}
                  {conflict.data.moves.slice(0, LIST_PAGE_SIZE).map((move, index) => (
                    <p key={index}>
                      {move.side}: {move.from} → {move.to}
                    </p>
                  ))}
                  {conflict.data.base !== null ? (
                    <CodePage text={conflict.data.base} label={conflict.data.labels.base} />
                  ) : (
                    <p>Base stage absent.</p>
                  )}
                  {conflict.data.current !== null ? (
                    <CodePage text={conflict.data.current} label={conflict.data.labels.current} />
                  ) : (
                    <p>Current stage absent.</p>
                  )}
                  {conflict.data.incoming !== null ? (
                    <CodePage text={conflict.data.incoming} label={conflict.data.labels.incoming} />
                  ) : (
                    <p>Incoming stage absent.</p>
                  )}
                  {conflict.data.worktree !== null ? (
                    <CodePage
                      text={conflict.data.worktree}
                      label="Actual working-directory conflict content"
                    />
                  ) : (
                    <p>Working-directory content unavailable or absent.</p>
                  )}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
export function PublishedInspection({
  api,
  identity,
  number,
  tab,
  head,
  onReview,
}: {
  api: DesktopAPI
  identity: string
  number: number | null
  tab: 'checks' | 'discussion'
  head: string | null
  onReview: () => void
}) {
  const [page, setPage] = useState(0)
  const checks = useQuery({
    queryKey: ['inspection-checks', identity, number, head],
    enabled: tab === 'checks' && number !== null,
    queryFn: async ({ signal }) => {
      if (!api.pullRequestChecks) throw new Error('Checks are unavailable')
      const cancel = () => void api.cancel('pull-request-checks')
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await api.pullRequestChecks(number!, { headSha: head })
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  const discussion = useQuery({
    queryKey: ['inspection-discussion', identity, number, head],
    enabled: tab === 'discussion' && number !== null,
    queryFn: async ({ signal }) => {
      if (!api.reviewThreads) throw new Error('Discussion is unavailable')
      const requestId = `discussion-${crypto.randomUUID()}`
      const cancel = () => void api.cancel(requestId)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const value = await api.reviewThreads(number!, requestId)
        signal.throwIfAborted()
        return value
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    gcTime: 0,
  })
  useEffect(() => setPage(0), [identity, tab])
  if (number === null)
    return <p>No associated pull request; {tab} requires published PR authority.</p>
  const query = tab === 'checks' ? checks : discussion
  const rows =
    tab === 'checks' ? (checks.data?.checks ?? []) : (discussion.data?.threads.threads ?? [])
  const pages = Math.max(1, Math.ceil(rows.length / LIST_PAGE_SIZE))
  return (
    <div>
      <p>
        Published PR #{number} · head <code>{head ?? 'Unknown'}</code>. Checks do not certify
        unpublished local changes.
      </p>
      <ReadStatus loading={query.isFetching} error={query.error} />
      {tab === 'checks' ? (
        <>
          {checks.data ? (
            <p>{checks.data.available ? checks.data.summary : checks.data.message}</p>
          ) : null}
          {checks.data?.checks
            .slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE)
            .map((check) => (
              <section className="bw-section" key={check.key}>
                <h3>{check.name}</h3>
                <Badge>{checkStateLabel(check.state)}</Badge>
                <p>{checkRequirementLabel(check.requirement)}</p>
                <p>{check.summary}</p>
                {check.detailsUrl ? (
                  <Button size="xs" onClick={() => void api.openExternal(check.detailsUrl!)}>
                    Open source details
                  </Button>
                ) : null}
              </section>
            ))}
        </>
      ) : (
        <>
          {discussion.data ? (
            <p>
              Read as {discussion.data.permissions.viewer} ·{' '}
              {discussion.data.threads.truncated
                ? 'Partial discussion'
                : `${discussion.data.threads.totalCount} threads`}
            </p>
          ) : null}
          {discussion.data?.threads.threads
            .slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE)
            .map((thread) => (
              <section className="bw-section" key={thread.id}>
                <h3>
                  {thread.path} · {thread.resolved ? 'Resolved' : 'Unresolved'}
                  {thread.outdated ? ' · outdated' : ''}
                </h3>
                {thread.comments.slice(0, 1).map((comment) => (
                  <div key={comment.id}>
                    <strong>{comment.author}</strong>
                    <p className="wb-comment">{comment.body}</p>
                  </div>
                ))}
                {thread.commentsTruncated || thread.comments.length > 1 ? (
                  <p>Additional comments are available in full review.</p>
                ) : null}
              </section>
            ))}
        </>
      )}
      {pages > 1 ? (
        <div className="bw-between">
          <Button disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page + 1} / {pages}
          </span>
          <Button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
      <Button onClick={onReview}>Open full review and original durable drafts</Button>
    </div>
  )
}
export function ContextHistory({
  api,
  identity,
  ref,
}: {
  api: DesktopAPI
  identity: string
  ref: string
}) {
  const [offsets, setOffsets] = useState([0])
  const page = offsets.length - 1
  const [oid, setOid] = useState<string | null>(null)
  const history = useQuery({
    queryKey: ['inspection-history', identity, ref, page],
    queryFn: async ({ signal }) => {
      const id = `history-${crypto.randomUUID()}`
      signal.addEventListener('abort', () => void api.cancel(id), { once: true })
      const result = await api.history(ref, offsets[page], id)
      signal.throwIfAborted()
      return result
    },
    gcTime: 0,
  })
  const diff = useQuery({
    queryKey: ['inspection-commit', identity, oid],
    enabled: Boolean(oid),
    queryFn: async ({ signal }) => {
      const id = `commit-${crypto.randomUUID()}`
      signal.addEventListener('abort', () => void api.cancel(id), { once: true })
      const result = await api.commitDiff(oid!, id)
      signal.throwIfAborted()
      return result
    },
    gcTime: 0,
  })
  return (
    <div>
      <ReadStatus loading={history.isFetching} error={history.error} />
      <p>
        Read-only committed history · <code>{ref}</code> · not local unstaged changes
      </p>
      {history.data?.commits.slice(0, LIST_PAGE_SIZE).map((commit) => (
        <Button key={commit.oid} variant="ghost" onClick={() => setOid(commit.oid)}>
          {commit.subject} · {commit.oid.slice(0, 10)}
        </Button>
      ))}
      <div className="bw-between">
        <Button
          disabled={!page}
          onClick={() => {
            setOffsets(offsets.slice(0, -1))
            setOid(null)
          }}
        >
          Previous commits
        </Button>
        <Button
          disabled={!history.data?.hasMore}
          onClick={() => {
            setOffsets([...offsets, offsets[page] + (history.data?.commits.length ?? 0)])
            setOid(null)
          }}
        >
          Next commits
        </Button>
      </div>
      <ReadStatus loading={diff.isFetching} error={diff.error} />
      {diff.data ? (
        <>
          {diff.data.truncated ? <p>Commit diff truncated.</p> : null}
          <CodePage text={diff.data.text} label={`Committed diff ${oid}`} />
        </>
      ) : null}
    </div>
  )
}
