import * as React from 'react'

import type { ReviewDiffMode, ReviewFile, ReviewLine } from '../../../shared/review'
import { reviewDiffStateLabel, reviewSplitRows, reviewUnifiedRows } from '../../../shared/review'
import { LIST_PAGE_SIZE } from '../../../shared/performance'
import { useListWindow } from '../lib/list-window'
import { ListWindowMore } from './list-window'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'

function lineClass(line: ReviewLine | null | undefined): string | undefined {
  if (!line) return undefined
  if (line.kind === 'add') return 'diff-add'
  if (line.kind === 'remove') return 'diff-remove'
  if (line.kind === 'marker') return 'hunk-marker'
  return undefined
}

function hiddenNote(hidden: number): string | null {
  if (hidden === 0) return null
  return `  (${hidden} whitespace-only line${hidden === 1 ? '' : 's'} hidden)`
}

/**
 * The diff surface.
 *
 * A pull request can change more text than fits in a document, so the rows are
 * windowed: only the visible pages are mounted, and the region label always names
 * the full size rather than what happens to be on screen. The whitespace filter
 * changes what is drawn and nothing else — the rows a person reads still carry
 * the identity a review comment would anchor to.
 */
export function ReviewDiff({
  file,
  mode,
  hideWhitespace,
}: {
  file: ReviewFile
  mode: ReviewDiffMode
  hideWhitespace: boolean
}) {
  if (file.diff.kind !== 'text') {
    return (
      <div className="code-region review-diff-region">
        <div className="code-region-header">
          <strong>{file.path}</strong>
          <Badge variant={file.diff.kind === 'binary' ? 'secondary' : 'warning'}>
            {file.diff.kind === 'binary' ? 'binary' : 'no text diff'}
          </Badge>
        </div>
        <p className="code-region-note">{reviewDiffStateLabel(file)}</p>
      </div>
    )
  }

  const hunks = file.diff.hunks
  return (
    <div className="code-region review-diff-region">
      <div className="code-region-header">
        <strong>{file.path}</strong>
        <span className="code-region-meta">
          {hunks.length} hunk{hunks.length === 1 ? '' : 's'} · +{file.additions} −{file.deletions}
        </span>
        {file.generated ? <Badge variant="outline">likely generated</Badge> : null}
      </div>
      {file.previousPath ? (
        <p className="code-region-note">
          Renamed from <code>{file.previousPath}</code>. A review comment anchors to{' '}
          <code>{file.path}</code>.
        </p>
      ) : null}
      {mode === 'split' ? (
        <SplitRows file={file} hideWhitespace={hideWhitespace} />
      ) : (
        <UnifiedRows file={file} hideWhitespace={hideWhitespace} />
      )}
    </div>
  )
}

function UnifiedRows({ file, hideWhitespace }: { file: ReviewFile; hideWhitespace: boolean }) {
  const rows = React.useMemo(
    () => (file.diff.kind === 'text' ? reviewUnifiedRows(file.diff.hunks, { hideWhitespace }) : []),
    [file, hideWhitespace],
  )
  const window_ = useListWindow(rows)
  const hidden = rows.reduce((total, row) => (row.kind === 'hunk' ? total + row.hidden : total), 0)
  return (
    <>
      {hidden > 0 ? (
        <p className="code-region-note">
          {hidden} whitespace-only line{hidden === 1 ? '' : 's'} hidden. Turn the filter off to see
          them.
        </p>
      ) : null}
      <pre
        className="code-diff review-unified"
        role="region"
        tabIndex={0}
        aria-label={`Unified diff, ${window_.visible.length} of ${rows.length} rows shown`}
      >
        {window_.visible.map((row, index) =>
          row.kind === 'hunk' ? (
            <span className="diff-hunk" key={`hunk:${row.hunkId}`}>
              {`${row.header}${hiddenNote(row.hidden) ?? ''}`}
              {'\n'}
            </span>
          ) : (
            <span className={lineClass(row.line)} key={`line:${row.hunkId}:${index}`}>
              <span aria-hidden="true" className="review-line-number">
                {row.number === null ? '' : `${row.number} `}
              </span>
              {row.line.text}
              {'\n'}
            </span>
          ),
        )}
      </pre>
      <ListWindowMore
        noun="diff rows"
        pageSize={LIST_PAGE_SIZE}
        previous={window_.hasPrevious}
        remaining={window_.remaining}
        onReveal={window_.reveal}
        onPrevious={window_.retreat}
      />
    </>
  )
}

function SplitRows({ file, hideWhitespace }: { file: ReviewFile; hideWhitespace: boolean }) {
  const rows = React.useMemo(
    () => (file.diff.kind === 'text' ? reviewSplitRows(file.diff.hunks, { hideWhitespace }) : []),
    [file, hideWhitespace],
  )
  const window_ = useListWindow(rows)
  return (
    <>
      <div
        className="review-split"
        role="region"
        tabIndex={0}
        aria-label={`Split diff, ${window_.visible.length} of ${rows.length} rows shown`}
      >
        {window_.visible.map((row, index) =>
          row.kind === 'hunk' ? (
            <div className="diff-hunk review-split-hunk" key={`hunk:${row.hunkId}`}>
              {`${row.header}${hiddenNote(row.hidden) ?? ''}`}
            </div>
          ) : (
            <div className="review-split-row" key={`split:${row.hunkId}:${index}`}>
              <span className={cn('review-split-cell', lineClass(row.left?.line))}>
                <span aria-hidden="true" className="review-split-gutter">
                  {row.left ? `${row.left.number} ` : ''}
                </span>
                {row.left ? `${row.left.line.text}\n` : ''}
              </span>
              <span className={cn('review-split-cell', lineClass(row.right?.line))}>
                <span aria-hidden="true" className="review-split-gutter">
                  {row.right ? `${row.right.number} ` : ''}
                </span>
                {row.right ? `${row.right.line.text}\n` : ''}
              </span>
            </div>
          ),
        )}
      </div>
      <ListWindowMore
        noun="diff rows"
        pageSize={LIST_PAGE_SIZE}
        previous={window_.hasPrevious}
        remaining={window_.remaining}
        onReveal={window_.reveal}
        onPrevious={window_.retreat}
      />
    </>
  )
}
