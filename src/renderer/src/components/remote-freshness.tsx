import * as React from 'react'
import { CheckCircle2, Clock, CloudOff, RefreshCw, ShieldAlert } from 'lucide-react'
import type { RemoteFreshness, RemoteFreshnessState } from '../../../shared/types'
import { describeFreshness } from '../lib/live-sync'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const ICON_BY_STATE: Record<RemoteFreshnessState, React.ComponentType<{ className?: string }>> = {
  fresh: CheckCircle2,
  refreshing: RefreshCw,
  stale: Clock,
  offline: CloudOff,
  'rate-limited': ShieldAlert,
  unauthorized: ShieldAlert,
}

/**
 * The remote freshness badge. Its state is written out in words and repeated in
 * the accessible description, so "not fresh" never depends on colour alone, and
 * it always says when the data was last confirmed.
 */
export function RemoteFreshnessBadge({
  freshness,
  now,
}: {
  freshness: RemoteFreshness | undefined
  now?: number
}) {
  const description = describeFreshness(freshness, now)
  const Icon = ICON_BY_STATE[freshness?.state ?? 'fresh']
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={description.variant}
          aria-label={description.detail}
          data-remote-freshness={freshness?.state ?? 'unknown'}
          // A hover-only tooltip would hide the same sentence from a keyboard
          // or a screen reader, so the badge itself is focusable and named.
          tabIndex={0}
          title={description.detail}
        >
          <Icon aria-hidden="true" className="size-3" />
          {description.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{description.detail}</TooltipContent>
    </Tooltip>
  )
}
