import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import { Search } from 'lucide-react'

function BranchField() {
  const [value, setValue] = useState('invalid branch')
  const error = value.includes(' ')
    ? 'Branch names cannot contain spaces. Use a hyphen.'
    : undefined
  return (
    <UI.Field
      id="branch-field"
      label="Branch name"
      required
      description="Validation is local; no branch is created."
      error={error}
    >
      <UI.Input value={value} onChange={(event) => setValue(event.target.value)} />
    </UI.Field>
  )
}
export const formSpecimens = {
  field: BranchField,
  label: () => (
    <div>
      <UI.Label htmlFor="label-example">Commit title</UI.Label>
      <UI.Input id="label-example" defaultValue="Preserve independent branch states" />
    </div>
  ),
  input: () => (
    <div className="grid gap-3">
      <UI.Input aria-label="Search branches" placeholder="Search branches" />
      <UI.Input aria-label="Unavailable input" disabled value="Repository unavailable" />
      <UI.Input aria-label="Invalid branch name" aria-invalid defaultValue="invalid branch" />
    </div>
  ),
  'input-group': () => (
    <UI.InputGroup>
      <UI.InputGroupAddon>
        <Search aria-hidden="true" />
      </UI.InputGroupAddon>
      <UI.InputGroupInput aria-label="Search commit history" placeholder="Search commit history" />
    </UI.InputGroup>
  ),
  textarea: () => (
    <UI.Field
      id="review-comment"
      label="Review comment"
      description="Write a local example comment."
    >
      <UI.Textarea defaultValue="The inspected branch differs from the checked-out branch. Please keep those states independent." />
    </UI.Field>
  ),
  checkbox: function Checkboxes() {
    const [checked, setChecked] = useState(false)
    return (
      <div className="grid gap-3">
        <UI.Checkbox
          label="Stage file locally"
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
        />
        <UI.Checkbox label="Partially staged (mixed)" indeterminate defaultChecked />
        <UI.Checkbox label="Unavailable file" disabled />
      </div>
    )
  },
  'radio-group': () => (
    <UI.RadioGroup defaultValue="split" aria-label="Diff mode">
      <UI.RadioGroupItem value="split">Split</UI.RadioGroupItem>
      <UI.RadioGroupItem value="unified">Unified</UI.RadioGroupItem>
    </UI.RadioGroup>
  ),
  switch: () => (
    <label className="design-specimen-row">
      <UI.Switch defaultChecked />
      Local notification example
    </label>
  ),
  select: function Select() {
    const [value, setValue] = useState('')
    return (
      <>
        <UI.Select
          aria-label="Branch filter"
          value={value}
          onValueChange={setValue}
          options={[
            { value: '', label: 'All branches (empty value)' },
            { value: 'local', label: 'Local branches' },
            { value: 'remote', label: 'Remote branches' },
            { value: 'unavailable', label: 'Unavailable', disabled: true },
          ]}
        />
        <output>Selected filter: {value || 'all'}</output>
      </>
    )
  },
  'native-select': () => (
    <UI.NativeSelect aria-label="Review scope" defaultValue="all">
      <UI.NativeSelectOption value="all">All files</UI.NativeSelectOption>
      <UI.NativeSelectOption value="changed">Changed files</UI.NativeSelectOption>
      <UI.NativeSelectOption disabled value="unavailable">
        Unavailable
      </UI.NativeSelectOption>
    </UI.NativeSelect>
  ),
  combobox: () => (
    <UI.Combobox items={['main', 'feature/quiet-graph', 'fix/focus-return']}>
      <UI.ComboboxInput aria-label="Find a branch" placeholder="Find a branch" />
      <UI.ComboboxContent>
        <UI.ComboboxEmpty>No branch matches.</UI.ComboboxEmpty>
        <UI.ComboboxList>
          {(branch: string) => (
            <UI.ComboboxItem key={branch} value={branch}>
              {branch}
            </UI.ComboboxItem>
          )}
        </UI.ComboboxList>
      </UI.ComboboxContent>
    </UI.Combobox>
  ),
  slider: function Slider() {
    const [value, setValue] = useState<number | readonly number[]>(3)
    return (
      <>
        <UI.Slider
          aria-label="Diff context lines"
          min={0}
          max={10}
          value={value}
          onValueChange={setValue}
        />
        <output>Context lines: {String(value)}</output>
      </>
    )
  },
  calendar: function Calendar() {
    const [date, setDate] = useState<Date | undefined>(new Date(2026, 9, 10))
    return (
      <>
        <UI.Calendar
          mode="single"
          defaultMonth={new Date(2026, 9, 1)}
          selected={date}
          onSelect={setDate}
        />
        <output>{date ? date.toLocaleDateString('en-US') : 'No date selected'}</output>
      </>
    )
  },
  'date-picker': () => <UI.DatePicker date={new Date(2026, 9, 10)} />,
  'input-otp': () => (
    <>
      <UI.Label htmlFor="otp-example">Local verification code</UI.Label>
      <UI.InputOTP id="otp-example" maxLength={6}>
        <UI.InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <UI.InputOTPSlot key={index} index={index} />
          ))}
        </UI.InputOTPGroup>
      </UI.InputOTP>
    </>
  ),
}
