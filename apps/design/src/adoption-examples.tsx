import { useState, type ComponentType } from 'react'
import { Button } from '@git-stacks/ui'
import { LoadingButtonExample } from './examples/loading-button'
import loadingSource from './examples/loading-button.tsx?raw'
import { FieldInputExample } from './examples/field-input'
import fieldSource from './examples/field-input.tsx?raw'
import { LabelledSelectExample } from './examples/labelled-select'
import selectSource from './examples/labelled-select.tsx?raw'
import { NoteDialogExample } from './examples/note-dialog'
import dialogSource from './examples/note-dialog.tsx?raw'
import { ScopedConfirmationExample } from './examples/scoped-confirmation'
import confirmationSource from './examples/scoped-confirmation.tsx?raw'

const fieldExample = {
  Preview: FieldInputExample,
  source: fieldSource,
  guidance:
    'Field supplies the visible label, required state, help and error relationships. Input owns only its value and events. Blur the empty input to inspect the error.',
}

const examples: Record<string, { Preview: ComponentType; source: string; guidance: string }> = {
  button: {
    Preview: LoadingButtonExample,
    source: loadingSource,
    guidance:
      'Keep the action label stable while loading. Report clipboard failure inline and clear busy state in finally. This example copies a ref; it does not run Git.',
  },
  field: fieldExample,
  input: fieldExample,
  select: {
    Preview: LabelledSelectExample,
    source: selectSource,
    guidance:
      'Field labels the Select trigger. Keep the string value controlled; the empty-string option is a real all-branches choice, not a missing selection.',
  },
  dialog: {
    Preview: NoteDialogExample,
    source: dialogSource,
    guidance:
      'Use the shared trigger, title and description for focus and naming. Own the draft outside the popup so closing and reopening preserves edits.',
  },
  'alert-dialog': {
    Preview: ScopedConfirmationExample,
    source: confirmationSource,
    guidance:
      'Name the captured identity and excluded scope before confirmation. Start on Cancel, preserve state on cancellation, and keep the final action dangerous. Production Git workflows still require their existing main-process previews and gates.',
  },
}

export function AdoptionExample({ id }: { id: string }) {
  const [copyState, setCopyState] = useState('')
  const example = examples[id]
  if (!example) return null
  const { Preview, source, guidance } = example

  async function copySource() {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState('Composition copied.')
    } catch {
      setCopyState('Clipboard access was refused. Select and copy the source below instead.')
    }
  }

  return (
    <section className="catalog-composition" aria-label={`${id} adoption example`}>
      <h3>Copyable composition</h3>
      <p>{guidance}</p>
      <div className="design-specimen">
        <Preview />
      </div>
      <p>
        The source below is the exact typed component rendered above. Use the shared UI styles and
        Tailwind setup documented in the README. Examples stay local; they are not Git transports.
      </p>
      <div className="design-specimen-row">
        <Button
          variant="secondary"
          onClick={() => void copySource()}
          aria-label={`Copy ${id} composition`}
        >
          Copy composition
        </Button>
        <output aria-live="polite">{copyState}</output>
      </div>
      <pre className="design-code" tabIndex={0} aria-label={`${id} composition source`}>
        <code>{source}</code>
      </pre>
    </section>
  )
}
