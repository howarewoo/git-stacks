import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import tokens from '@git-stacks/ui/tokens.json'

function tokenValue(value: string): string {
  const reference = /^\{([^}]+)\}$/.exec(value)
  if (!reference) return value
  const resolved = reference[1]
    .split('.')
    .reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], tokens)
  if (typeof resolved !== 'string') throw new Error(`Missing token: ${reference[1]}`)
  return tokenValue(resolved)
}

export function TypographySpecimen() {
  return (
    <div className="grid gap-4">
      {(['heading', 'body', 'label', 'metadata'] as const).map((role) => (
        <UI.Typography key={role} variant={role}>
          {role} — {tokens.semantic.type[`${role}-size`]} / {tokens.semantic.type[`${role}-line`]} /{' '}
          {role === 'heading' ? 600 : role === 'label' ? 500 : 400}
        </UI.Typography>
      ))}
      <UI.Typography variant="code">
        src/graph.ts · feature/quiet-graph · c54a283 · 1,024
      </UI.Typography>
      <p>
        System sans for reading; system monospace for refs, paths, OIDs and code. No external fonts.
      </p>
      <UI.Separator />
      <UI.Typography variant="h1" as="h3">
        Content typography
      </UI.Typography>
      <UI.Typography variant="h2" as="h4">
        Readable review documentation
      </UI.Typography>
      <UI.Typography variant="p">
        Showcase content has a larger scale than compact workbench UI.{' '}
        <a href="#git-compositions">Inspect the Git examples</a> before changing a state.
      </UI.Typography>
      <UI.Typography variant="list">
        <li>Inspection never implies checkout.</li>
        <li>Unavailable checks never imply passing.</li>
      </UI.Typography>
      <UI.Typography variant="blockquote">
        Capture the scope before asking for confirmation.
      </UI.Typography>
      <UI.Typography variant="p">
        Use <UI.Typography variant="inlineCode">git diff</UI.Typography> as displayed code, not an
        executable action.
      </UI.Typography>
      <pre className="design-code">
        {'git diff main...feature/quiet-graph\n// display only — never executed'}
      </pre>
      <table className="numeric-example">
        <caption>Tabular numeric alignment</caption>
        <tbody>
          <tr>
            <td>Files</td>
            <td>12</td>
          </tr>
          <tr>
            <td>Lines</td>
            <td>1,024</td>
          </tr>
          <tr>
            <td>Comments</td>
            <td>7</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function Foundations() {
  const semantic = tokens.semantic
  return (
    <section id="foundations" className="design-entry" tabIndex={-1}>
      <h2>Foundations</h2>
      <p>Canonical roles, generated from one shared token source.</p>
      <div className="foundation-colors">
        {Object.entries(semantic.feedback)
          .filter(([name]) => name.endsWith('surface'))
          .map(([name]) => (
            <div
              key={name}
              style={{
                background: `var(--gs-semantic-feedback-${name})`,
                color: `var(--gs-semantic-feedback-${name.replace('surface', 'text')})`,
              }}
            >
              {name}
            </div>
          ))}
      </div>
      {(['space', 'radius', 'elevation', 'motion', 'density', 'z'] as const).map((role) => (
        <div key={role}>
          <h3>{role === 'z' ? 'Layers' : role}</h3>
          <dl className="foundation-values">
            {Object.entries(semantic[role]).map(([name, value]) => (
              <div key={name}>
                <dt>
                  <code>
                    semantic.{role}.{name}
                  </code>
                </dt>
                <dd>{tokenValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <h3>Focus</h3>
      <UI.Button variant="secondary">Tab here to inspect focus</UI.Button>
      <p>
        Focus ring: <code>semantic.focus.ring</code>. Essential controls retain visible boundaries,
        explicit labels and focus rings in both themes. Motion respects the system reduced-motion
        preference.
      </p>
    </section>
  )
}

const branches = [
  {
    id: 41,
    parent: null,
    branch: 'feature/quiet-graph',
    author: 'Ada',
    lifecycle: 'Open',
    checks: 'Unavailable',
    review: 'Requested',
    restack: 'Clean',
  },
  {
    id: 42,
    parent: 41,
    branch: 'fix/focus-return',
    author: 'Lin',
    lifecycle: 'Draft',
    checks: 'Passing',
    review: 'Changes requested',
    restack: 'Needed',
  },
  {
    id: 43,
    parent: 41,
    branch: 'feature/review-notes',
    author: 'Sam',
    lifecycle: 'Merged',
    checks: 'Unknown',
    review: 'Approved',
    restack: 'Unavailable',
  },
  {
    id: 44,
    parent: 42,
    branch: 'fix/long-ref-name-with-many-segments-and-a-very-long-description',
    author: 'Ada',
    lifecycle: 'Open',
    checks: 'Failing',
    review: 'Unavailable',
    restack: 'Conflict',
  },
] as const
export function GitCompositions() {
  const [inspected, setInspected] = useState<number>(41)
  const [checkedOut, setCheckedOut] = useState('main')
  const [captured, setCaptured] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [result, setResult] = useState('No operation performed')
  const [reply, setReply] = useState('')
  const [comments, setComments] = useState<string[]>([])
  return (
    <section id="git-compositions" className="design-entry git-compositions" tabIndex={-1}>
      <h2>Git compositions</h2>
      <p>
        Deterministic local simulations. No Git, GitHub, repository access, or desktop bridge. PR
        chains have no team or stack names.
      </p>
      <h3>Branching PR graph</h3>
      <p>
        Checked out: <code>{checkedOut}</code> · inspected: PR #{inspected}
      </p>
      <div className="git-graph" role="list" aria-label="Branching pull request graph">
        {branches.map((branch) => (
          <div
            role="listitem"
            key={branch.id}
            className="git-row"
            data-inspected={inspected === branch.id}
            style={{
              marginInlineStart: branch.parent === null ? 0 : branch.parent === 41 ? 20 : 40,
            }}
          >
            <div className="design-specimen-row">
              <span>
                {branch.parent ? `PR #${branch.parent} → ` : 'main → '}PR #{branch.id}
              </span>
              <UI.Button
                variant={inspected === branch.id ? 'accent' : 'ghost'}
                onClick={() => setInspected(branch.id)}
              >
                Inspect #{branch.id}
              </UI.Button>
            </div>
            <code>{branch.branch}</code>
            <div className="design-specimen-row">
              <span>{branch.author}</span>
              <UI.Badge>{branch.lifecycle}</UI.Badge>
              <UI.Badge
                variant={
                  branch.checks === 'Passing'
                    ? 'success'
                    : branch.checks === 'Failing'
                      ? 'danger'
                      : 'warning'
                }
              >
                Checks: {branch.checks}
              </UI.Badge>
              <span>Review: {branch.review}</span>
              <span>Restack: {branch.restack}</span>
            </div>
            <UI.Button variant="secondary" onClick={() => setCheckedOut(branch.branch)}>
              Simulate checkout #{branch.id}
            </UI.Button>
          </div>
        ))}
      </div>
      <h3 id="diff">Diff preview</h3>
      <p>
        <code>src/graph.ts</code> · 1 addition, 1 removal · display only
      </p>
      <pre className="diff-preview">
        <span className="diff-hunk">@@ -12,1 +12,1 @@</span>
        {'\n'}
        <span className="diff-remove">- const active = checkedOut</span>
        {'\n'}
        <span className="diff-add">+ const active = inspected</span>
      </pre>
      <h3>Review conversation</h3>
      <UI.Message>
        <UI.MessageContent>
          <UI.MessageHeader>Lin · 10 October 2026, 09:30 UTC</UI.MessageHeader>
          <UI.Bubble>
            <UI.BubbleContent>
              Please preserve independent checkout and inspection.
            </UI.BubbleContent>
          </UI.Bubble>
        </UI.MessageContent>
      </UI.Message>
      {comments.map((comment, index) => (
        <UI.Bubble key={index}>
          <UI.BubbleContent>{comment}</UI.BubbleContent>
        </UI.Bubble>
      ))}
      <UI.Field id="composition-reply" label="Local review reply">
        <UI.Textarea value={reply} onChange={(event) => setReply(event.target.value)} />
      </UI.Field>
      <UI.Button
        disabled={!reply.trim()}
        onClick={() => {
          setComments([...comments, reply])
          setReply('')
        }}
      >
        Add local reply
      </UI.Button>
      <h3>Scoped destructive preview</h3>
      <p>
        Scope: PR #42 and descendant #44 only. PR #43 is outside this scope. Remote state
        unavailable; no remote operation is offered.
      </p>
      <UI.Button
        variant="secondary"
        onClick={() => {
          setCaptured(true)
          setConfirmation('')
        }}
      >
        Capture local deletion preview
      </UI.Button>
      {captured && (
        <div className="grid gap-3">
          <pre className="design-code">
            {
              'git branch -d fix/focus-return\ngit branch -d fix/long-ref-name-with-many-segments-and-a-very-long-description\n// Captured display only'
            }
          </pre>
          <UI.AlertDialog>
            <UI.AlertDialogTrigger render={<UI.Button variant="danger" />}>
              Review destructive simulation
            </UI.AlertDialogTrigger>
            <UI.AlertDialogContent>
              <UI.AlertDialogHeader>
                <UI.AlertDialogTitle>Delete two local example branches?</UI.AlertDialogTitle>
                <UI.AlertDialogDescription>
                  Captured scope: #42 and #44. This changes only a local result label. Type DELETE
                  to enable confirmation.
                </UI.AlertDialogDescription>
              </UI.AlertDialogHeader>
              <UI.Field id="destructive-confirmation" label="Confirmation">
                <UI.Input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </UI.Field>
              <UI.AlertDialogFooter>
                <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
                <UI.AlertDialogAction
                  disabled={confirmation !== 'DELETE'}
                  onClick={() => {
                    setResult(
                      'Deletion simulated for #42 and #44 only. No Git operation performed.',
                    )
                    setCaptured(false)
                  }}
                >
                  Simulate deletion
                </UI.AlertDialogAction>
              </UI.AlertDialogFooter>
            </UI.AlertDialogContent>
          </UI.AlertDialog>
        </div>
      )}
      <output aria-live="polite">{result}</output>
    </section>
  )
}
