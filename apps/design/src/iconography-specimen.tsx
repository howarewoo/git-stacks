import { useState } from 'react'
import { Button, IconButton } from '@git-stacks/ui'
import {
  GitBranch,
  Search,
  RefreshCw,
  ExternalLink,
  X,
  GitCommitHorizontal,
  GitPullRequest,
  FileText,
  FileDiff,
  CircleCheck,
  TriangleAlert,
  CircleOff,
  CircleHelp,
} from 'lucide-react'

export function IconographySpecimen() {
  const [feedback, setFeedback] = useState('No example action activated.')
  return (
    <div className="iconography-specimen">
      <div>
        <h3>Navigation and actions</h3>
        <p>
          16px glyphs accompany 36px compact controls; 20px glyphs suit 44px standard controls. The
          glyph is not the target: icon-only controls retain 44px targets.
        </p>
        <div className="design-specimen-row">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFeedback('Branch example opened locally.')}
          >
            <GitBranch size={16} aria-hidden="true" /> Browse branches
          </Button>
          <Button
            variant="secondary"
            onClick={() => setFeedback('Search example activated locally.')}
          >
            <Search size={20} aria-hidden="true" /> Search example
          </Button>
          <IconButton
            label="Refresh icon example"
            variant="ghost"
            onClick={() => setFeedback('Refresh example completed locally.')}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Close icon example"
            variant="ghost"
            onClick={() => setFeedback('Close example activated locally.')}
          >
            <X size={20} aria-hidden="true" />
          </IconButton>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFeedback('External-link example activated locally; no page opened.')}
          >
            <ExternalLink size={16} aria-hidden="true" /> Open example documentation
          </Button>
        </div>
        <p className="iconography-feedback" role="status">
          {feedback} These examples never call Git or a network operation.
        </p>
      </div>
      <div>
        <h3>Git objects</h3>
        <ul className="iconography-list">
          <li>
            <GitCommitHorizontal size={16} aria-hidden="true" /> Commit
          </li>
          <li>
            <GitPullRequest size={16} aria-hidden="true" /> Pull request
          </li>
          <li>
            <FileText size={16} aria-hidden="true" /> File
          </li>
          <li>
            <FileDiff size={16} aria-hidden="true" /> Diff
          </li>
        </ul>
        <p>
          Keep outlines consistent: Lucide’s default 2px stroke and currentColor inherit the
          surrounding semantic foreground. Align icons with their label and prevent shrinking.
        </p>
      </div>
      <div>
        <h3>Status has visible meaning</h3>
        <ul className="iconography-list iconography-status-list">
          <li className="iconography-success">
            <CircleCheck size={16} aria-hidden="true" />
            <span>Success: checks passed</span>
          </li>
          <li className="iconography-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>Warning: restack required</span>
          </li>
          <li className="iconography-neutral">
            <CircleOff size={16} aria-hidden="true" />
            <span>Unavailable: remote facts could not be read</span>
          </li>
          <li className="iconography-neutral">
            <CircleHelp size={16} aria-hidden="true" />
            <span>Unknown: check result not reported</span>
          </li>
        </ul>
        <p>
          The desktop remote-freshness indicator uses a smaller 12px inline glyph beside explicit
          status text, not a smaller action target.
        </p>
      </div>
      <div>
        <h3>Compose, don’t wrap</h3>
        <p>
          Import named icons directly from lucide-react and Button / IconButton from @git-stacks/ui.
          Decorative icons use aria-hidden; a meaningful standalone icon needs an accessible name.
          Ambiguous actions need a visible label, not just a tooltip.
        </p>
        <p>
          <a href="https://lucide.dev/icons/" target="_blank" rel="noreferrer">
            Browse the Lucide icon catalog (opens in a new tab)
          </a>
        </p>
        <p>
          For loading, retain Button’s loading contract and shared Spinner instead of animating an
          action glyph. Preserve the action name, disabled dispatch and reduced-motion behavior.
        </p>
      </div>
    </div>
  )
}
