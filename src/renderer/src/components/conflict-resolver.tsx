import * as React from 'react'
import { Check, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react'
import type {
  ConflictChoice,
  ConflictFile,
  ConflictRegion,
  ConflictResolution,
} from '../../../shared/types'
import {
  composeConflict,
  hasConflictMarkers,
  parseConflictSegments,
} from '../../../shared/conflict'
import type { ConflictRegionChoice } from '../../../shared/conflict'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Textarea } from './ui/textarea'
import {
  OperationContext,
  PhaseStatus,
  WorkflowActions,
  WorkflowFrame,
} from './workflow-composition'
import { workflowError, type RunAction } from './workflow-dialog'
import { closeIntent, CLOSE_INTENT_MESSAGES } from './workflow-policy'

const KIND_LABELS: Record<ConflictFile['kind'], string> = {
  content: 'Content conflict',
  addAdd: 'Added on both sides',
  modifyDelete: 'Deleted by the incoming side',
  deleteModify: 'Deleted by the checked-out side',
  rename: 'Path moved by the operation',
}

const STAGE_LABELS: Record<number, string> = { 1: 'base', 2: 'current', 3: 'incoming' }

function stagePane(
  text: string | null,
  present: boolean,
  binary: boolean,
  label: string,
  truncated: boolean,
) {
  if (!present) return `${label} has no version in this conflict.`
  if (text === null)
    return binary
      ? `${label} is binary, so there is no text to merge here.`
      : `${label} could not be read as text.`
  // A multi-megabyte single line can be present in a Git blob but cannot be
  // painted reliably as one <pre> line. Keep the pane small; choices use Git bytes.
  const display = text.length > 4096 ? text.slice(0, 4096) : text
  return truncated || display.length < text.length
    ? `${display}\n\n[Preview ends here; the full staged version is kept by Git.]`
    : display
}

function regionResult(region: ConflictRegion, choice: ConflictRegionChoice | undefined) {
  return composeConflict(
    [
      {
        kind: 'conflict',
        current: region.current,
        incoming: region.incoming,
        startLine: region.startLine,
      },
    ],
    { 0: choice ?? 'current' },
  )
}

function RegionCard({
  region,
  labels,
  result,
  disabled,
  onChoose,
  onEdit,
}: {
  region: ConflictRegion
  labels: ConflictFile['labels']
  result: string
  disabled: boolean
  onChoose: (choice: ConflictChoice) => void
  onEdit: (text: string) => void
}) {
  return (
    <li className="conflict-region">
      <div className="conflict-region-head">
        <strong>Conflict {region.index + 1}</strong>
        <span className="code-region-meta">from line {region.startLine}</span>
      </div>
      <div className="conflict-region-sides">
        <div className="conflict-pane">
          <div className="conflict-pane-head">
            <span>{labels.current}</span>
          </div>
          <pre className="code-diff" aria-label={`Conflict ${region.index + 1}, ${labels.current}`}>
            {region.current || 'No lines on this side.'}
          </pre>
        </div>
        <div className="conflict-pane">
          <div className="conflict-pane-head">
            <span>{labels.incoming}</span>
          </div>
          <pre
            className="code-diff"
            aria-label={`Conflict ${region.index + 1}, ${labels.incoming}`}
          >
            {region.incoming || 'No lines on this side.'}
          </pre>
        </div>
      </div>
      <div className="workflow-row">
        <Button
          aria-label={`Accept ${labels.current} for conflict ${region.index + 1}`}
          disabled={disabled}
          size="sm"
          tooltip={`Replace conflict ${region.index + 1} with the ${labels.current} lines.`}
          variant="secondary"
          onClick={() => onChoose('current')}
        >
          Accept {labels.current}
        </Button>
        <Button
          aria-label={`Accept ${labels.incoming} for conflict ${region.index + 1}`}
          disabled={disabled}
          size="sm"
          tooltip={`Replace conflict ${region.index + 1} with the ${labels.incoming} lines.`}
          variant="secondary"
          onClick={() => onChoose('incoming')}
        >
          Accept {labels.incoming}
        </Button>
        <Button
          aria-label={`Accept both sides for conflict ${region.index + 1}`}
          disabled={disabled}
          size="sm"
          tooltip={`Keep the ${labels.current} lines and then the ${labels.incoming} lines.`}
          variant="secondary"
          onClick={() => onChoose('both')}
        >
          Accept both
        </Button>
        <Button
          aria-label={`Remove the lines of conflict ${region.index + 1}`}
          disabled={disabled}
          size="sm"
          tooltip="Remove the conflicting lines without deleting the file."
          variant="ghost"
          onClick={() => onChoose('delete')}
        >
          Remove region
        </Button>
      </div>
      <label htmlFor={`conflict-region-${region.index}`}>Resolved lines for this conflict</label>
      <Textarea
        disabled={disabled}
        id={`conflict-region-${region.index}`}
        onChange={(event) => onEdit(event.target.value)}
        rows={4}
        spellCheck={false}
        value={result}
      />
    </li>
  )
}

/**
 * The dedicated three-way conflict resolver. It explains the active Git
 * operation in that operation's own terms, shows the index stages Git recorded
 * for the path, and stages a resolution only after the worktree and index
 * identity it was read under is revalidated. Continue and abort stay with Git.
 */
export function ConflictResolver({
  path,
  busy,
  conflictPresent,
  actionError,
  runAction,
  onClose,
}: {
  path: string
  conflictPresent: boolean
  busy: boolean
  actionError: string | null
  runAction: RunAction
  onClose: () => void
}) {
  const [file, setFile] = React.useState<ConflictFile | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [stale, setStale] = React.useState(false)
  const [choices, setChoices] = React.useState<Record<number, ConflictRegionChoice>>({})
  const [edited, setEdited] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const [closeNotice, setCloseNotice] = React.useState<string | null>(null)
  const [modeNotice, setModeNotice] = React.useState(false)
  const [handoffNotice, setHandoffNotice] = React.useState(false)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setStale(false)
    setEdited(null)
    setCloseNotice(null)
    setModeNotice(false)
    setHandoffNotice(false)
    window.desktop
      .conflictView(path)
      .then((next) => {
        if (!active) return
        setFile(next)
        setChoices(
          Object.fromEntries(next.regions.map((region) => [region.index, 'current' as const])),
        )
      })
      .catch((value) => {
        if (!active) return
        setFile(null)
        setError(workflowError(value))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [path, attempt])

  const segments = React.useMemo(
    () => (file?.worktree && !file.truncated ? parseConflictSegments(file.worktree) : []),
    [file],
  )
  const composed = React.useMemo(
    () => (file ? composeConflict(segments, choices) : ''),
    [choices, file, segments],
  )
  const result = edited ?? (file?.regions.length ? composed : (file?.worktree ?? ''))
  const editable = Boolean(file && !file.binary && !file.truncated && file.worktree !== null)
  const outdated = stale || !conflictPresent
  const markersRemain = hasConflictMarkers(result)

  const regionEditBlocked = edited !== null && edited !== composed
  const dirty = regionEditBlocked || Object.values(choices).some((choice) => choice !== 'current')
  const choose = (index: number, choice: ConflictRegionChoice) => {
    setHandoffNotice(false)
    if (regionEditBlocked) {
      setModeNotice(true)
      return
    }
    setEdited(null)
    setChoices((current) => ({ ...current, [index]: choice }))
  }
  const chooseEverywhere = (choice: ConflictChoice) => {
    setHandoffNotice(false)
    if (regionEditBlocked) {
      setModeNotice(true)
      return
    }
    setEdited(null)
    setChoices((current) => {
      const next = { ...current }
      for (const region of file?.regions ?? []) next[region.index] = choice
      return next
    })
  }

  const apply = async (resolution: ConflictResolution) => {
    if (!file || busy || loading || outdated) return
    const succeeded = await runAction(
      {
        type: 'resolveConflict',
        path: file.path,
        fingerprint: file.fingerprint,
        resolution,
      },
      'Resolve and stage conflict',
    )
    if (succeeded) {
      onClose()
      return
    }
    // A refused resolution means the worktree or index moved under the open
    // resolver. Re-read the identity and ask for an explicit reload rather than
    // retrying against content that is no longer the one on screen.
    try {
      const fresh = await window.desktop.conflictView(path)
      setStale(fresh.fingerprint !== file.fingerprint)
    } catch {
      setStale(true)
    }
  }

  const openMergeTool = async (discardDraft = false) => {
    if (!file || busy || loading || outdated) return
    if (dirty && !discardDraft) {
      setHandoffNotice(true)
      return
    }
    const succeeded = await runAction(
      { type: 'conflictMergeTool', path: file.path, fingerprint: file.fingerprint },
      'Open external merge tool',
    )
    if (succeeded) {
      setHandoffNotice(false)
      setAttempt((value) => value + 1)
    } else {
      try {
        const fresh = await window.desktop.conflictView(path)
        setStale(fresh.fingerprint !== file.fingerprint)
      } catch {
        setStale(true)
      }
    }
  }

  const facts = file
    ? [
        { label: 'Operation', value: file.labels.title },
        { label: 'Path', value: file.path, code: true },
        { label: 'Conflict', value: KIND_LABELS[file.kind] },
        {
          label: 'Index stages',
          value: file.stages.map((stage) => `${stage} · ${STAGE_LABELS[stage]}`).join('  '),
        },
        ...file.moves.map((move) => ({
          label: `Path moved by the ${move.side} side`,
          value: `${move.from} → ${move.to}`,
          code: true,
        })),
      ]
    : []

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) return
        const intent = closeIntent({ busy: busy || loading, dirty })
        if (intent === 'allow') onClose()
        else setCloseNotice(CLOSE_INTENT_MESSAGES[intent])
      }}
      open
    >
      <DialogContent className="workflow-dialog conflict-resolver">
        <DialogHeader>
          <DialogTitle>Resolve conflict</DialogTitle>
          <DialogDescription>
            {file ? `${file.labels.title} in` : 'Reading the conflict in'} {file?.path ?? path}
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-form">
          <WorkflowFrame composition="reviewed" wide>
            {closeNotice ? (
              <PhaseStatus phase="blocked" title="Draft kept open" message={closeNotice} />
            ) : null}
            {actionError ? (
              <PhaseStatus phase="failed" title="Conflict action failed" message={actionError} />
            ) : null}
            {loading ? (
              <p className="workflow-loading" role="status">
                <LoaderCircle className="size-4 animate-spin" />
                Reading index stages…
              </p>
            ) : error ? (
              <PhaseStatus phase="failed" title="Cannot open this conflict" message={error} />
            ) : file ? (
              <>
                {outdated ? (
                  <PhaseStatus
                    phase="blocked"
                    title={
                      conflictPresent
                        ? 'This file changed while the resolver was open'
                        : 'This conflict was resolved outside the resolver'
                    }
                    message={
                      conflictPresent
                        ? 'Nothing was written or staged. Your draft remains here. Keep editing it, or explicitly discard it and reload the current conflict.'
                        : 'The index no longer has this conflict (it may have been staged or the operation aborted). Your unstaged draft remains here so you can copy it before explicitly closing; it cannot be staged against the old conflict.'
                    }
                  />
                ) : null}
                {handoffNotice ? (
                  <div className="workflow-row">
                    <p className="workflow-note" role="status">
                      Your unstaged draft is still intact. The external tool starts from the working
                      tree, not these edits. Explicitly discard this draft to hand off the file.
                    </p>
                    <Button
                      disabled={busy}
                      size="sm"
                      variant="danger"
                      onClick={() => openMergeTool(true)}
                    >
                      Discard draft and open external merge tool
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setHandoffNotice(false)}>
                      Keep editing
                    </Button>
                  </div>
                ) : null}
                <OperationContext
                  description={file.labels.explanation}
                  facts={facts}
                  title={file.labels.title}
                />
                {file.binary ? (
                  <PhaseStatus
                    phase="blocked"
                    title="Binary conflict"
                    message="There is no text to merge in this file. Keep one side, accept the deletion, or hand the file to the configured merge tool."
                  />
                ) : null}
                {file.truncated ? (
                  <PhaseStatus
                    phase="blocked"
                    title="File too large to edit here"
                    message="Stage and worktree text is shown only as a bounded preview. Accepting one side or staging the worktree uses the complete original bytes, never this preview."
                  />
                ) : null}
                {file.kind === 'rename' ? (
                  <PhaseStatus
                    phase="blocked"
                    title="The operation moved this path"
                    message="Git recorded a rename for this path. Review the recorded source and destination below before choosing a resolution; only this selected path is staged."
                  />
                ) : null}
                <div className="conflict-panes">
                  <div className="conflict-pane">
                    <div className="conflict-pane-head">
                      <span>{file.labels.base}</span>
                      <Badge variant="secondary">stage 1</Badge>
                    </div>
                    <pre className="code-diff" aria-label={file.labels.base}>
                      {stagePane(
                        file.base,
                        file.stages.includes(1),
                        file.binary,
                        'The base',
                        file.stagePreviewTruncated.includes(1),
                      )}
                    </pre>
                  </div>
                  <div className="conflict-pane">
                    <div className="conflict-pane-head">
                      <span>{file.labels.current}</span>
                      <Badge variant="secondary">stage 2</Badge>
                    </div>
                    <pre className="code-diff" aria-label={file.labels.current}>
                      {stagePane(
                        file.current,
                        file.stages.includes(2),
                        file.binary,
                        'This side',
                        file.stagePreviewTruncated.includes(2),
                      )}
                    </pre>
                  </div>
                  <div className="conflict-pane">
                    <div className="conflict-pane-head">
                      <span>{file.labels.incoming}</span>
                      <Badge variant="secondary">stage 3</Badge>
                    </div>
                    <pre className="code-diff" aria-label={file.labels.incoming}>
                      {stagePane(
                        file.incoming,
                        file.stages.includes(3),
                        file.binary,
                        'This side',
                        file.stagePreviewTruncated.includes(3),
                      )}
                    </pre>
                  </div>
                </div>
                {file.regions.length ? (
                  <p className="workflow-note">
                    {file.regions.length} conflicting region
                    {file.regions.length === 1 ? '' : 's'} in this file. Decide each one, then stage
                    the result.
                  </p>
                ) : null}
                {modeNotice && regionEditBlocked ? (
                  <div className="workflow-row">
                    <p className="workflow-note" role="status">
                      Your Resolved file edits are still intact. To edit regions again, explicitly
                      discard the whole-file draft; changes outside the regions will be lost.
                    </p>
                    <Button
                      disabled={busy}
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setEdited(null)
                        setModeNotice(false)
                      }}
                    >
                      Discard full-file draft and use regions
                    </Button>
                  </div>
                ) : null}
                {editable && file.regions.length > 0 ? (
                  <ul className="conflict-regions">
                    {file.regions.map((region) => (
                      <RegionCard
                        key={region.index}
                        disabled={busy}
                        labels={file.labels}
                        region={region}
                        result={regionResult(region, choices[region.index])}
                        onChoose={(choice) => choose(region.index, choice)}
                        onEdit={(text) => choose(region.index, { kind: 'manual', text })}
                      />
                    ))}
                  </ul>
                ) : null}
                {editable ? (
                  <>
                    {file.regions.length > 0 ? (
                      <div className="workflow-row">
                        <Button
                          aria-label={`Accept ${file.labels.current} for every conflict`}
                          disabled={busy}
                          size="sm"
                          tooltip={`Keep the ${file.labels.current} lines in every region.`}
                          variant="secondary"
                          onClick={() => chooseEverywhere('current')}
                        >
                          Accept all {file.labels.current}
                        </Button>
                        <Button
                          aria-label={`Accept ${file.labels.incoming} for every conflict`}
                          disabled={busy}
                          size="sm"
                          tooltip={`Keep the ${file.labels.incoming} lines in every region.`}
                          variant="secondary"
                          onClick={() => chooseEverywhere('incoming')}
                        >
                          Accept all {file.labels.incoming}
                        </Button>
                        <Button
                          aria-label="Accept both sides in every conflict"
                          disabled={busy}
                          size="sm"
                          tooltip="Keep the current lines and then the incoming lines in every region."
                          variant="secondary"
                          onClick={() => chooseEverywhere('both')}
                        >
                          Accept both everywhere
                        </Button>
                      </div>
                    ) : null}
                    <label htmlFor="conflict-result">Resolved file</label>
                    <Textarea
                      className="conflict-content"
                      disabled={busy}
                      id="conflict-result"
                      onChange={(event) => {
                        setEdited(event.target.value)
                        setHandoffNotice(false)
                        setModeNotice(false)
                      }}
                      rows={10}
                      spellCheck={false}
                      value={result}
                    />
                    <p className="workflow-note">
                      Editing this file is the manual path. Every region has to be decided: a file
                      that still contains conflict markers is refused.
                    </p>
                  </>
                ) : null}
                {!editable || file.regions.length === 0 ? (
                  <div className="workflow-row">
                    <Button
                      aria-label={`Accept ${file.labels.current} and stage`}
                      disabled={busy || outdated || !file.stages.includes(2)}
                      size="sm"
                      tooltip={`Replace this file with the ${file.labels.current} version and stage it.`}
                      variant="secondary"
                      onClick={() => apply({ kind: 'choice', choice: 'current' })}
                    >
                      Accept {file.labels.current}
                    </Button>
                    <Button
                      aria-label={`Accept ${file.labels.incoming} and stage`}
                      disabled={busy || outdated || !file.stages.includes(3)}
                      size="sm"
                      tooltip={`Replace this file with the ${file.labels.incoming} version and stage it.`}
                      variant="secondary"
                      onClick={() => apply({ kind: 'choice', choice: 'incoming' })}
                    >
                      Accept {file.labels.incoming}
                    </Button>
                    {!file.binary && !file.truncated ? (
                      <Button
                        aria-label="Accept both sides and stage"
                        disabled={
                          busy || outdated || !file.stages.includes(2) || !file.stages.includes(3)
                        }
                        size="sm"
                        tooltip="Keep the current version and then the incoming version in one file."
                        variant="secondary"
                        onClick={() => apply({ kind: 'choice', choice: 'both' })}
                      >
                        Accept both
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <div className="workflow-row">
                  <Button
                    disabled={busy || outdated || !file.mergeTool.available}
                    size="sm"
                    tooltip={
                      file.mergeTool.available
                        ? `Open this file in ${file.mergeTool.tool}. Nothing is staged until it is marked resolved here.`
                        : file.mergeTool.reason
                    }
                    variant="secondary"
                    onClick={() => openMergeTool()}
                  >
                    <ExternalLink className="size-3.5" />
                    Open in external merge tool
                  </Button>
                  <Button
                    aria-label="Accept the deletion and stage it"
                    disabled={busy || outdated}
                    size="sm"
                    tooltip="Accept the deletion: the file is removed and the removal is staged. This cannot be undone through Git."
                    variant="danger"
                    onClick={() => apply({ kind: 'choice', choice: 'delete' })}
                  >
                    Accept the deletion
                  </Button>
                </div>
              </>
            ) : null}
            <WorkflowActions>
              <Button
                disabled={busy}
                onClick={() => {
                  if (file && outdated && conflictPresent) setAttempt((value) => value + 1)
                  else onClose()
                }}
                tooltip={
                  file && !conflictPresent
                    ? 'Discard this local draft and close. The externally staged result or abort is not changed.'
                    : file && outdated
                      ? 'Discard the local draft and reload the current index stages.'
                      : file
                        ? dirty
                          ? 'Discard this local draft and close without staging. The Git operation stays paused.'
                          : 'Close without staging. The Git operation stays paused, so it can still be continued or aborted.'
                        : undefined
                }
                variant="secondary"
              >
                {file && outdated
                  ? conflictPresent
                    ? 'Discard draft and reload conflict'
                    : 'Discard draft and close'
                  : 'Close'}
              </Button>
              {editable ? (
                <Button
                  disabled={busy || loading || outdated || markersRemain}
                  loading={busy}
                  tooltip={
                    markersRemain
                      ? 'Every conflicting region has to be decided before the file can be staged.'
                      : 'Write this content and stage it to mark the conflict resolved.'
                  }
                  variant="accent"
                  onClick={() => apply({ kind: 'content', content: result })}
                >
                  <Check className="size-3.5" />
                  Mark resolved and stage
                </Button>
              ) : file && (file.binary || file.truncated) && file.worktreePresent ? (
                <Button
                  disabled={busy || loading || outdated}
                  loading={busy}
                  tooltip="Stage the entire existing worktree file without converting or replacing its bytes. Review the external result first."
                  variant="accent"
                  onClick={() => apply({ kind: 'worktree' })}
                >
                  <Check className="size-3.5" />
                  Mark complete worktree file resolved and stage
                </Button>
              ) : null}
            </WorkflowActions>
            {outdated && conflictPresent ? (
              <p className="workflow-note">
                <TriangleAlert aria-hidden="true" className="conflict-inline-icon" />
                Reloading re-reads the index stages and working tree and discards the draft shown
                here.
              </p>
            ) : null}
          </WorkflowFrame>
        </div>
      </DialogContent>
    </Dialog>
  )
}
