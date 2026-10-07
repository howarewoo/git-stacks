import * as React from 'react'
import { ExternalLink, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react'
import type {
  PullRequestCheckDetail,
  PullRequestCheckRequirement,
  PullRequestChecksReport,
} from '../../../shared/pull-request-checks'
import {
  checkLabel,
  checkRequirementLabel,
  checkRequirementVariant,
  checkSourceLabel,
  checkStateLabel,
  checkStateVariant,
  checksFreshnessNote,
  checksVariant,
  checksWatchDisabledReason,
} from '../lib/pull-request-state'
import { Badge } from './ui/badge'
import { Button, IconButton } from './ui/button'
import { InlineAlert } from './ui/surface'

const GROUPS: Array<{ requirement: PullRequestCheckRequirement; title: string }> = [
  { requirement: 'required', title: 'Required' },
  { requirement: 'informational', title: 'Informational' },
  { requirement: 'unknown', title: 'Requirement unknown' },
]

function durationLabel(check: PullRequestCheckDetail): string | null {
  if (!check.startedAt) return null
  const started = Date.parse(check.startedAt)
  if (Number.isNaN(started)) return null
  const ended = check.completedAt ? Date.parse(check.completedAt) : null
  if (ended === null || Number.isNaN(ended)) return 'running'
  const seconds = Math.max(0, Math.round((ended - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function CheckRow({
  check,
  canRerun,
  rerunning,
  onRerun,
  onOpenDetails,
}: {
  check: PullRequestCheckDetail
  canRerun: boolean
  rerunning: boolean
  onRerun: (check: PullRequestCheckDetail) => void
  onOpenDetails: (url: string) => void
}) {
  const duration = durationLabel(check)
  const details = check.detailsUrl
  return (
    <li className="check-row">
      <div className="check-row-main">
        <span className="check-name" title={check.name}>
          {check.name}
        </span>
        <span className="check-meta">
          {checkSourceLabel(check.source)}
          {check.app ? ` · ${check.app}` : ''}
          {duration ? ` · ${duration}` : ''}
        </span>
        {check.summary ? <span className="check-summary">{check.summary}</span> : null}
      </div>
      <span className="check-badges">
        <Badge variant={checkRequirementVariant(check.requirement)}>
          {checkRequirementLabel(check.requirement)}
        </Badge>
        <Badge variant={checkStateVariant(check.state)}>{checkStateLabel(check.state)}</Badge>
      </span>
      <span className="check-actions">
        {details ? (
          <IconButton
            label={`Open ${check.name} details on GitHub`}
            onClick={() => onOpenDetails(details)}
          >
            <ExternalLink className="size-3.5" />
          </IconButton>
        ) : null}
        {check.workflowRunId !== null ? (
          <Button
            disabled={!canRerun}
            aria-label={`Rerun ${check.name} workflow`}
            loading={rerunning}
            size="sm"
            variant="secondary"
            tooltip={
              canRerun
                ? 'Rerun this GitHub Actions workflow. GitHub restarts the run; nothing local changes.'
                : 'Rerunning workflows is not permitted for this repository.'
            }
            onClick={() => onRerun(check)}
          >
            <RotateCcw className="size-3.5" />
            Rerun
          </Button>
        ) : null}
      </span>
    </li>
  )
}

/**
 * The drill-down behind the compact checks badge: every check GitHub reported for this
 * pull request head, with the source that reported it, its own state, and whether the
 * repository requires it. Required, informational, and unproven checks are separate
 * groups, so a required failure never hides inside a passing optional one.
 *
 * The panel also states its own currency. A report GitHub confirmed in this call reads
 * as current; anything remembered from an earlier read is labelled, with the reason and
 * the time, because a cached failure is not a passing check.
 */
export function PullRequestChecksPanel({
  report,
  loading,
  watching,
  onToggleWatch,
  onRefresh,
  onRerun,
  onOpenDetails,
  rerunningRunId,
}: {
  report: PullRequestChecksReport | null
  loading: boolean
  watching: boolean
  onToggleWatch: () => void
  onRefresh: () => void
  onRerun: (check: PullRequestCheckDetail) => void
  onOpenDetails: (url: string) => void
  rerunningRunId: number | null
}) {
  if (loading && !report) {
    return (
      <section aria-label="Checks" className="detail-section checks-panel">
        <h3>Checks</h3>
        <p className="check-note" role="status">
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
          Reading checks from GitHub…
        </p>
      </section>
    )
  }
  if (!report) return null

  const freshness = checksFreshnessNote(report)
  const watchBlocked = checksWatchDisabledReason(report)
  const rollup = report.rollup

  return (
    <section aria-label="Checks" className="detail-section checks-panel">
      <h3>Checks</h3>
      <div className="checks-summary">
        <Badge variant={report.available ? checksVariant(report.summary) : 'outline'}>
          <ShieldCheck className="size-3" />
          {report.available ? checkLabel(report.summary) : 'checks unavailable'}
        </Badge>
        <span className="check-note">
          {!report.available
            ? 'Checks are unavailable for this head.'
            : rollup.total === 0
              ? 'No check runs, commit statuses, or Actions runs are reported for this head.'
              : `${rollup.passing} passed · ${rollup.failing} failing · ${rollup.pending} pending` +
                (rollup.skipped || rollup.neutral || rollup.unknown
                  ? ` · ${rollup.skipped} skipped · ${rollup.neutral} neutral · ${rollup.unknown} unknown`
                  : '')}
        </span>
      </div>
      {rollup.requirementKnown ? (
        <p className="check-note">
          {rollup.requiredFailing} required failing · {rollup.requiredPending} required pending ·{' '}
          {rollup.requiredTotal} required of {rollup.total} checks
        </p>
      ) : (
        <p className="check-note check-explanation">
          Git Stacks could not read this repository&apos;s required checks, so no check is claimed
          to be required or optional.
        </p>
      )}
      {report.truncated ? (
        <InlineAlert tone="warning" title="More checks than shown">
          GitHub reported more check runs, commit statuses, or workflow runs for this head than Git
          Stacks read. Everything listed here is what GitHub reported; the list is not the whole of
          it.
        </InlineAlert>
      ) : null}
      <InlineAlert className="check-explanation" tone={freshness.tone} title={freshness.title}>
        {freshness.detail}
      </InlineAlert>
      <div className="checks-controls">
        <Button
          disabled={loading}
          size="sm"
          variant="secondary"
          tooltip="Re-read these checks from GitHub, ignoring the minimum interval between refreshes."
          onClick={onRefresh}
        >
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          Refresh checks
        </Button>
        <Button
          aria-pressed={watching}
          disabled={watchBlocked !== null}
          size="sm"
          variant="secondary"
          tooltip={
            watchBlocked ??
            'Re-read these checks while they are still running, backing off when GitHub asks Git Stacks to wait.'
          }
          onClick={onToggleWatch}
        >
          {watching ? 'Stop watching' : 'Watch checks'}
        </Button>
      </div>
      {!report.permissions.canRerun && report.permissions.reason ? (
        <p className="check-note check-explanation">{report.permissions.reason}</p>
      ) : null}
      {GROUPS.map(({ requirement, title }) => {
        const group = report.checks.filter((check) => check.requirement === requirement)
        if (group.length === 0) return null
        return (
          <div className="check-group" key={requirement}>
            <h4>
              {title} ({group.length})
            </h4>
            <ul className="check-list">
              {group.map((check) => (
                <CheckRow
                  canRerun={report.permissions.canRerun}
                  check={check}
                  key={check.key}
                  rerunning={rerunningRunId === check.workflowRunId}
                  onRerun={onRerun}
                  onOpenDetails={onOpenDetails}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
