import * as React from 'react'
import { GitBranch } from 'lucide-react'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { InlineAlert } from './ui/surface'
import type { PublishProgress, PublishStepStatus, StackStep } from '../../../shared/types'
import { PHASE_PRESENTATION, type WorkflowComposition, type WorkflowPhase } from './workflow-policy'

/**
 * The three reusable compositions named in the design brief — ordinary form,
 * reviewed operation, and destructive confirmation — plus the state model they
 * all render. Domain inputs and validation stay in the calling dialog; this
 * module owns the shared heading/context/body/footer rhythm and the action
 * roles, so the three compositions read as one family.
 */

const frameWidth: Record<WorkflowComposition, string> = {
  form: 'max-w-lg',
  reviewed: 'max-w-[620px]',
  destructive: 'max-w-lg',
}

export function WorkflowFrame({
  composition,
  wide = false,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  composition: WorkflowComposition
  wide?: boolean
}) {
  return (
    <div
      data-composition={composition}
      data-workflow-frame=""
      className={cn(
        'grid min-w-0 gap-4',
        wide ? 'max-w-[760px]' : frameWidth[composition],
        className,
      )}
      {...props}
    />
  )
}

export function WorkflowSection({
  label,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'section'> & { label?: React.ReactNode }) {
  return (
    <section
      aria-label={typeof label === 'string' ? label : undefined}
      className={cn('grid min-w-0 gap-2', className)}
      {...props}
    >
      {label ? (
        <h3 className="m-0 text-[length:var(--gs-semantic-type-label-size)] font-semibold uppercase tracking-wide text-[var(--gs-semantic-text-secondary)]">
          {label}
        </h3>
      ) : null}
      {children}
    </section>
  )
}

export interface ContextFact {
  label: string
  value: React.ReactNode
  /** Rendered as a monospace ref/OID so long identifiers stay scannable. */
  code?: boolean
}

/**
 * The context block every reviewed operation and destructive confirmation
 * opens with: what will change, where it will change, and the commit or ref
 * identifiers the preview actually supplied.
 */
export function OperationContext({
  title,
  description,
  facts,
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  facts?: readonly ContextFact[]
  className?: string
}) {
  if (!title && !description && !facts?.length) return null
  return (
    <WorkflowSection label="What this changes" className={className}>
      {title ? (
        <p className="m-0 text-[length:var(--gs-semantic-type-body-size)] font-medium text-[var(--gs-semantic-text-primary)]">
          {title}
        </p>
      ) : null}
      {description ? (
        <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] leading-relaxed text-[var(--gs-semantic-text-secondary)]">
          {description}
        </p>
      ) : null}
      {facts?.length ? <OperationFacts facts={facts} /> : null}
    </WorkflowSection>
  )
}

export function OperationFacts({
  facts,
  className,
}: {
  facts: readonly ContextFact[]
  className?: string
}) {
  return (
    <dl
      className={cn(
        'm-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] px-3 py-2.5',
        className,
      )}
    >
      {facts.map((fact) => (
        <React.Fragment key={fact.label}>
          <dt className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
            {fact.label}
          </dt>
          <dd
            className={cn(
              'm-0 min-w-0 break-words text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-primary)]',
              fact.code && 'font-mono',
            )}
          >
            {fact.value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/**
 * The planned steps of a reviewed stack operation. Each row is the real branch,
 * parent, commit count, and OID from the preview — no step is invented.
 */
export function OperationSteps({
  steps,
  label,
  emptyNote,
  className,
}: {
  steps: readonly StackStep[]
  label: string
  emptyNote?: string
  className?: string
}) {
  if (!steps.length) {
    return emptyNote ? (
      <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
        {emptyNote}
      </p>
    ) : null
  }
  return (
    <ol aria-label={label} className={cn('m-0 grid list-none gap-2 p-0', className)}>
      {steps.map((step) => (
        <li
          key={step.branch}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)] px-3 py-2.5"
        >
          <GitBranch
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--gs-semantic-text-secondary)]"
          />
          <div className="grid min-w-0 gap-1">
            <strong className="break-words text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)]">
              {step.branch}
            </strong>
            <span className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
              into {step.parent} · {step.commits} commit{step.commits === 1 ? '' : 's'} ·{' '}
              <code className="font-mono">{step.oid.slice(0, 10)}</code>
            </span>
            {step.note ? (
              <p className="m-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                {step.note}
              </p>
            ) : null}
          </div>
          {step.pr ? (
            <span className="col-span-2 col-start-2 flex flex-wrap items-center gap-1.5 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
              <Badge variant={step.pr.state === 'OPEN' ? 'secondary' : 'outline'}>
                {step.pr.draft ? 'draft' : step.pr.state.toLowerCase()}
              </Badge>
              <span>
                #{step.pr.number} · {step.pr.head} → {step.pr.base}
              </span>
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

export function PhaseStatus({
  phase,
  title,
  message,
  className,
}: {
  phase: WorkflowPhase
  /** Overrides the phase label when the surface has its own headline. */
  title?: React.ReactNode
  message?: React.ReactNode
  className?: string
}) {
  const presentation = PHASE_PRESENTATION[phase]
  if (phase === 'ready' && !title) {
    if (!message) return null
    return (
      <p
        className={cn(
          'm-0 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]',
          className,
        )}
      >
        {message}
      </p>
    )
  }
  return (
    <InlineAlert
      key={phase}
      tone={presentation.tone === 'neutral' ? 'info' : presentation.tone}
      title={title ?? presentation.label}
      className={className}
      aria-live={presentation.live === 'off' ? undefined : presentation.live}
    >
      {message}
    </InlineAlert>
  )
}

/** A blocker list that stays on screen until the underlying preview changes. */
export function BlockerList({
  title = 'Resolve before continuing',
  items,
}: {
  title?: string
  items: readonly string[]
}) {
  if (!items.length) return null
  return (
    <InlineAlert tone="error" title={title}>
      <ul className="m-0 mt-1 grid list-disc gap-1 pl-4">
        {items.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
    </InlineAlert>
  )
}

export function WarningNote({ children }: { children: React.ReactNode }) {
  return <InlineAlert tone="warning">{children}</InlineAlert>
}

/**
 * A typed confirmation. The input never enables its action by itself: the caller
 * compares the value against the shown name, so an incomplete name cannot submit.
 */
export function TypedConfirmation({
  id,
  value,
  target,
  onChange,
  disabled = false,
  label,
}: {
  id: string
  value: string
  target: string
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
}) {
  const matches = value === target
  return (
    <Field
      id={id}
      label={label ?? `Type ${target} to confirm`}
      description={
        matches
          ? 'Confirmed. This action is enabled.'
          : 'The name must match exactly. Nothing runs until it does.'
      }
      error={value && !matches ? 'The typed name does not match yet.' : undefined}
    >
      <Input
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

/** Shared footer rhythm: secondary escape action first, roles after it. */
export function WorkflowActions({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-[var(--gs-semantic-border-essential)] pt-3',
        className,
      )}
    >
      {children}
    </div>
  )
}

const stepStatusLabel: Record<PublishStepStatus, string> = {
  pending: 'waiting',
  running: 'running',
  completed: 'done',
  failed: 'stopped',
}

/**
 * What a submission has actually finished. The rows are the persisted steps, so
 * a resume shows real completed work rather than a re-run of the whole plan, and
 * a stopped step carries the recovery that unblocks it.
 */
export function PublishProgressPanel({
  progress,
  className,
}: {
  progress: PublishProgress | null
  className?: string
}) {
  if (!progress) return null
  const stopped = progress.steps.find((step) => step.status === 'failed')
  const done = progress.steps.filter((step) => step.status === 'completed').length
  return (
    <WorkflowSection
      className={className}
      label={`Submission progress — ${done} of ${progress.steps.length} steps done`}
    >
      {progress.status === 'completed' ? (
        <InlineAlert tone="success">{progress.message}</InlineAlert>
      ) : stopped?.failure ? (
        <InlineAlert tone="error">
          <strong className="block">{stopped.failure.summary}</strong>
          {stopped.failure.recovery}
        </InlineAlert>
      ) : (
        <InlineAlert tone="info">{progress.message}</InlineAlert>
      )}
      <ol aria-label="Submission steps" className="m-0 grid list-none gap-1.5 p-0">
        {progress.steps.map((step, index) => (
          <li
            key={`${step.kind}-${step.branch ?? 'stack'}-${index}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-content)] px-3 py-2"
          >
            <Badge
              variant={step.status === 'failed' ? 'danger' : 'secondary'}
              className="mt-0.5 shrink-0"
            >
              {stepStatusLabel[step.status]}
            </Badge>
            <div className="grid min-w-0 gap-0.5">
              <strong className="break-words text-[length:var(--gs-semantic-type-label-size)] text-[var(--gs-semantic-text-primary)]">
                {step.label}
              </strong>
              <span className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                {step.detail}
                {step.pullRequest === null ? '' : ` · #${step.pullRequest}`}
              </span>
            </div>
            {progress.resumeAt === index && step.status === 'failed' ? (
              <span className="col-span-2 col-start-2 text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                {step.failure?.retryable
                  ? 'Retry continues from this step without repeating the finished ones.'
                  : 'This step cannot be retried; dismiss the submission and take a fresh preview.'}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </WorkflowSection>
  )
}
