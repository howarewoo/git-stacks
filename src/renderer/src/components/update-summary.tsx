import React from 'react'
import type { UpdateChannel, UpdateStatus } from '../../../shared/update'
import { InlineAlert } from './ui/surface'
import { OperationFacts, type ContextFact } from './workflow-composition'

const TRUST_LABEL: Record<UpdateStatus['trust'], string> = {
  release: 'Release signing key compiled into this build',
  development: 'Development key from this machine’s environment',
  none: 'No signing key in this build',
}

const PHASE_LABEL: Record<UpdateStatus['phase'], string> = {
  idle: 'Not checked yet',
  'not-configured': 'Updates are switched off in this build',
  unsupported: 'This platform is not updated in place',
  checking: 'Checking for a signed release…',
  current: 'This is the newest signed release for this channel',
  available: 'A signed release is ready to download',
  downloading: 'Downloading and verifying the signed release…',
  downloaded: 'The release is downloaded and verified. Install it when you are ready.',
  installing: 'Installing and restarting…',
  failed: 'The last attempt did not finish',
  cancelled: 'Cancelled. Nothing was changed.',
}

/** Phases that say something an available offer does not. */
const OUTCOME_PHASES = new Set<UpdateStatus['phase']>([
  'checking',
  'current',
  'downloading',
  'downloaded',
  'installing',
  'failed',
  'cancelled',
])

/**
 * What the updater is true about on this machine, before any control is
 * offered. Everything here comes from the main process, including the release
 * notes, which are signed release text from the network and are therefore shown
 * as text and never as markup.
 *
 * The facts and the notice are separate so each can sit with the part of the
 * settings surface it belongs to: the facts describe this build, and the
 * notice describes what the last thing it did resulted in.
 */
export function UpdateSummary({
  status,
  channel,
}: {
  status: UpdateStatus | null
  channel: UpdateChannel
}) {
  return (
    <>
      <UpdateFacts status={status} channel={channel} />
      <UpdateNotice status={status} />
    </>
  )
}

/** What is true about this build, shown beside the channel it follows. */
export function UpdateFacts({
  status,
  channel,
}: {
  status: UpdateStatus | null
  channel: UpdateChannel
}) {
  return <OperationFacts facts={updateFacts(status, channel)} />
}

/** What the updater is doing right now, in the terms it reported. */
export function UpdateNotice({ status }: { status: UpdateStatus | null }) {
  return notice(status)
}

/** The facts about the updater that are true regardless of what it is doing. */
export function updateFacts(status: UpdateStatus | null, channel: UpdateChannel): ContextFact[] {
  return [
    { label: 'Installed version', value: status?.currentVersion ?? 'Unknown', code: true },
    { label: 'Channel', value: channel },
    { label: 'Signing key', value: TRUST_LABEL[status?.trust ?? 'none'] },
    {
      label: 'In-place updates',
      value: status
        ? status.supported
          ? 'Supported on this platform'
          : 'Not supported on this platform'
        : 'Reading platform support…',
    },
  ]
}

/**
 * What the updater is doing, in the terms it reported. A refusal is shown with
 * the reason main gave, never softened into a suggestion to try again with the
 * same result.
 */
function notice(status: UpdateStatus | null) {
  if (!status) return <InlineAlert tone="info">Reading the update state…</InlineAlert>
  const offer = status.offer
  const offered = offer
    ? `Version ${offer.version} on the ${offer.channel} channel${
        offer.rollbackOf ? `, an authorised rollback of ${offer.rollbackOf}` : ''
      } · ${Math.round(offer.size / (1024 * 1024))} MB for ${offer.platform} ${offer.arch}`
    : null
  // The phase leads whenever it says something the offer does not: a person
  // still holding a valid offer must be able to read that the download
  // finished, that an install is running, or that the last attempt was refused.
  const leads = offered === null || OUTCOME_PHASES.has(status.phase)
  const headline = leads ? PHASE_LABEL[status.phase] : (offered as string)
  const body = status.failure
    ? `${status.failure.message} (${status.failure.reason})`
    : leads && offered !== null
      ? `${offered}${offer?.notes ? ` — ${offer.notes}` : ''}`
      : offer?.notes
  return (
    <>
      <InlineAlert tone={status.failure ? 'warning' : 'info'}>
        {headline}
        {body ? ` — ${body}` : ''}
      </InlineAlert>
      {status.restartRequired ? (
        <InlineAlert tone="success">The update is installed. Restart to use it.</InlineAlert>
      ) : null}
    </>
  )
}
