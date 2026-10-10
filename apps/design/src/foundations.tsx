import { useRef, useState } from 'react'
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

const foundationUsage: Record<string, Record<string, string>> = {
  space: {
    '1': 'Dense metadata',
    '2': 'Related controls and help',
    '3': 'Fields and fact groups',
    '4': 'Section rhythm',
    '5': 'Workbench content inset',
    '6': 'Major section separation',
    '8': 'Generous section separation',
    '10': 'Page breathing room',
  },
  radius: {
    control: 'Buttons and editable controls',
    item: 'Rows and grouped items',
    workbench: 'Work surfaces and dialogs',
    pill: 'Badges and segmented controls',
  },
  elevation: {
    small: 'Complete content cards',
    medium: 'Floating menus and tooltips',
    large: 'Dialog layers',
  },
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
                <dd>
                  {role === 'space' && (
                    <div className="foundation-preview" aria-hidden="true">
                      <span
                        className="foundation-space"
                        style={{ width: `var(--gs-semantic-space-${name})` }}
                      />
                    </div>
                  )}
                  {role === 'radius' && (
                    <div className="foundation-preview" aria-hidden="true">
                      <span
                        className="foundation-shape"
                        style={{ borderRadius: `var(--gs-semantic-radius-${name})` }}
                      />
                    </div>
                  )}
                  {role === 'elevation' && (
                    <div className="foundation-preview" aria-hidden="true">
                      <span
                        className="foundation-layer"
                        style={{ boxShadow: `var(--gs-semantic-elevation-${name})` }}
                      />
                    </div>
                  )}
                  <span>{tokenValue(value)}</span>
                  {foundationUsage[role]?.[name] && (
                    <p className="foundation-usage">{foundationUsage[role][name]}</p>
                  )}
                </dd>
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

const deletionScope = [branches[1], branches[3]]
export function GitCompositions() {
  const [inspected, setInspected] = useState<number>(41)
  const [checkedOut, setCheckedOut] = useState('main')
  const [captured, setCaptured] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [result, setResult] = useState('No operation performed')
  const [reply, setReply] = useState('')
  const [comments, setComments] = useState<string[]>([])
  const cancelRef = useRef<HTMLButtonElement>(null)
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
        {[branches[0], branches[1], branches[3], branches[2]].map((branch) => (
          <div
            role="listitem"
            key={branch.id}
            className="git-row"
            data-inspected={inspected === branch.id}
            data-depth={branch.parent === null ? 0 : branch.parent === 41 ? 1 : 2}
          >
            <span className="git-ancestry" aria-hidden="true">
              <span className="git-node" />
            </span>
            <div className="git-identity">
              <div className="git-ref">
                <code>{branch.branch}</code>
                {checkedOut === branch.branch && <UI.Badge variant="accent">Checked out</UI.Badge>}
              </div>
              <span className="git-parent">
                {branch.parent ? `PR #${branch.parent} → ` : 'main → '}PR #{branch.id} ·{' '}
                {branch.author}
              </span>
            </div>
            <div className="git-actions">
              <UI.Button
                size="sm"
                variant={inspected === branch.id ? 'accent' : 'ghost'}
                aria-pressed={inspected === branch.id}
                onClick={() => setInspected(branch.id)}
              >
                Inspect #{branch.id}
              </UI.Button>
              <UI.Button size="sm" variant="secondary" onClick={() => setCheckedOut(branch.branch)}>
                Simulate checkout #{branch.id}
              </UI.Button>
            </div>
            <div className="git-facts">
              <UI.Badge variant={branch.lifecycle === 'Merged' ? 'merged' : 'secondary'}>
                {branch.lifecycle}
              </UI.Badge>
              <UI.Badge
                variant={
                  branch.checks === 'Passing'
                    ? 'success'
                    : branch.checks === 'Failing'
                      ? 'danger'
                      : 'secondary'
                }
              >
                Checks: {branch.checks}
              </UI.Badge>
              <span>Review: {branch.review}</span>
              <span>Restack: {branch.restack}</span>
            </div>
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
            {`${deletionScope.map(({ branch }) => `git branch -d ${branch}`).join('\n')}\n// Captured display only`}
          </pre>
          <UI.AlertDialog>
            <UI.AlertDialogTrigger render={<UI.Button variant="danger" />}>
              Review destructive simulation
            </UI.AlertDialogTrigger>
            <UI.AlertDialogContent
              className="max-h-[calc(100dvh-32px)] overflow-y-auto"
              initialFocus={cancelRef}
            >
              <UI.AlertDialogHeader>
                <UI.AlertDialogTitle>Delete two local example branches?</UI.AlertDialogTitle>
                <UI.AlertDialogDescription>
                  Local simulation only; no Git operation will run. PR #43 is outside this scope.
                  Remote state is unavailable; no remote operation is offered.
                </UI.AlertDialogDescription>
              </UI.AlertDialogHeader>
              <ul className="confirmation-scope" aria-label="Captured branches">
                {deletionScope.map(({ id, branch, parent }) => (
                  <li key={id}>
                    <span>
                      PR #{id}
                      {id === 44 ? ` · descendant of #${parent}` : ''}
                    </span>
                    <code>{branch}</code>
                  </li>
                ))}
              </ul>
              <UI.Field
                id="destructive-confirmation"
                label="Confirmation"
                description="Type DELETE to enable the simulation."
              >
                <UI.Input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </UI.Field>
              <UI.AlertDialogFooter>
                <UI.AlertDialogCancel ref={cancelRef}>Cancel</UI.AlertDialogCancel>
                <UI.AlertDialogAction
                  variant="danger"
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
