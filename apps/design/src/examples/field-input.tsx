import { useId, useState } from 'react'
import { Field, Input } from '@git-stacks/ui'

export function FieldInputExample() {
  const id = useId()
  const [title, setTitle] = useState('')
  const [touched, setTouched] = useState(false)
  const error = touched && !title.trim() ? 'Enter a title before saving the draft.' : undefined

  return (
    <Field
      id={id}
      label="Example draft title"
      required
      description="A local draft only; this example does not create a commit."
      error={error}
    >
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => setTouched(true)}
      />
    </Field>
  )
}
