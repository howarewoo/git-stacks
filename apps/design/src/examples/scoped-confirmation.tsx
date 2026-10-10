import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from '@git-stacks/ui'

const exampleRef = 'feature/quiet-graph'

export function ScopedConfirmationExample() {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [removed, setRemoved] = useState(false)

  return (
    <div className="grid gap-3">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button variant="danger" disabled={removed} />}>
          Remove example ref
        </AlertDialogTrigger>
        <AlertDialogContent initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this example ref?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove {exampleRef} from this specimen only. Other refs are outside this scope. No
              branch, pull request, or remote state is changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} variant="secondary">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                setRemoved(true)
                setOpen(false)
              }}
            >
              Remove example ref
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <output aria-live="polite">
        {removed
          ? `Example ref removed: ${exampleRef}. No Git operation ran.`
          : `Example ref retained: ${exampleRef}.`}
      </output>
      {removed && (
        <Button variant="secondary" onClick={() => setRemoved(false)}>
          Reset local example
        </Button>
      )}
    </div>
  )
}
