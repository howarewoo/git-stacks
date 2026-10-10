import { useId, useState } from 'react'
import { Field, Select } from '@git-stacks/ui'

export function LabelledSelectExample() {
  const id = useId()
  const [scope, setScope] = useState('')

  return (
    <div className="grid gap-3">
      <Field id={id} label="Example branch scope" description="An empty value means all branches.">
        <Select
          value={scope}
          onValueChange={setScope}
          options={[
            { value: '', label: 'All branches' },
            { value: 'local', label: 'Local branches' },
            { value: 'remote', label: 'Remote branches' },
            { value: 'unavailable', label: 'Unavailable scope', disabled: true },
          ]}
        />
      </Field>
      <output aria-live="polite">Example scope: {scope || 'all'}</output>
    </div>
  )
}
