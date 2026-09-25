import * as React from 'react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'

export function FoundationsSpecimen() {
  const [query, setQuery] = React.useState('feature/tokens')

  return (
    <main className="foundations-specimen" aria-labelledby="specimen-title">
      <div className="foundations-specimen-header">
        <div>
          <p className="foundations-specimen-eyebrow">Git Stacks foundations</p>
          <h1 id="specimen-title">Renderer specimen</h1>
          <p>Semantic roles in a quiet developer workbench.</p>
        </div>
        <Badge variant="accent">Design system</Badge>
      </div>

      <section className="foundations-specimen-card" aria-labelledby="specimen-controls-title">
        <div className="foundations-specimen-section-heading">
          <div>
            <h2 id="specimen-controls-title">Controls</h2>
            <p>Actions, fields, and status are independently labelled.</p>
          </div>
          <Badge variant="success">Ready</Badge>
        </div>
        <form className="foundations-specimen-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="specimen-branch">Branch name</label>
          <Input
            id="specimen-branch"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="feature/my-change"
          />
          <Button type="submit">Create branch</Button>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </form>
      </section>

      <section className="foundations-specimen-card" aria-labelledby="specimen-row-title">
        <div className="foundations-specimen-section-heading">
          <div>
            <h2 id="specimen-row-title">Branch stack</h2>
            <p>Selection and checked-out state remain independent.</p>
          </div>
          <Badge variant="outline">2 branches</Badge>
        </div>
        <div className="foundations-specimen-rows" role="list" aria-label="Branch stack">
          <div className="foundations-specimen-row" role="listitem">
            <span className="foundations-specimen-branch-mark" aria-hidden="true">
              ●
            </span>
            <span className="foundations-specimen-branch-copy">
              <strong>main</strong>
              <small>origin/main · up to date</small>
            </span>
            <Badge variant="secondary">Default</Badge>
          </div>
          <div
            className="foundations-specimen-row foundations-specimen-row-selected"
            role="listitem"
            aria-current="true"
          >
            <span className="foundations-specimen-branch-mark" aria-hidden="true">
              ↳
            </span>
            <span className="foundations-specimen-branch-copy">
              <strong>{query || 'feature/my-change'}</strong>
              <small>Selected · local branch</small>
            </span>
            <Badge variant="accent">Selected</Badge>
            <Badge variant="info">Current</Badge>
          </div>
        </div>
      </section>

      <section className="foundations-specimen-card" aria-labelledby="specimen-diff-title">
        <div className="foundations-specimen-section-heading">
          <div>
            <h2 id="specimen-diff-title">Diff excerpt</h2>
            <p>Addition, deletion, and hunk roles include readable text.</p>
          </div>
          <Badge variant="warning">1 review</Badge>
        </div>
        <pre className="foundations-specimen-diff" tabIndex={0} aria-label="Sample unified diff">
          <span className="foundations-diff-hunk">@@ -1,2 +1,2 @@</span>
          {'\n'}
          <span className="foundations-diff-remove">- const accent = &apos;purple&apos;</span>
          {'\n'}
          <span className="foundations-diff-add">+ const selection = &apos;blue&apos;</span>
          {'\n'}
        </pre>
      </section>
    </main>
  )
}
