import { useId, useState } from 'react'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Textarea,
} from '@git-stacks/ui'

export function NoteDialogExample() {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('Keep inspection independent of checkout.')
  const [saved, setSaved] = useState('No example note saved.')

  return (
    <div className="grid gap-3">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="secondary" />}>Edit example note</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit example note</DialogTitle>
            <DialogDescription>
              Closing preserves this draft. Saving changes only this specimen, not a GitHub review.
            </DialogDescription>
          </DialogHeader>
          <Field id={id} label="Example note">
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Close without saving</DialogClose>
            <Button
              disabled={!note.trim()}
              onClick={() => {
                setSaved(`Example note saved: ${note}`)
                setOpen(false)
              }}
            >
              Save example note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <output aria-live="polite">{saved}</output>
    </div>
  )
}
