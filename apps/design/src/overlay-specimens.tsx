import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import { FileDiff, GitBranch, X } from 'lucide-react'

export const overlaySpecimens = {
  dialog: function Inspection() {
    const [action, setAction] = useState('No nested action selected')
    return (
      <UI.Dialog>
        <UI.DialogTrigger render={<UI.Button />}>Open inspection dialog</UI.DialogTrigger>
        <UI.DialogContent>
          <UI.DialogHeader>
            <UI.DialogTitle>Branch inspection</UI.DialogTitle>
            <UI.DialogDescription>
              Focus stays inside this local example until it closes.
            </UI.DialogDescription>
          </UI.DialogHeader>
          <UI.Field id="dialog-ref" label="Ref">
            <UI.Input defaultValue="feature/quiet-graph" />
          </UI.Field>
          <UI.Popover>
            <UI.PopoverTrigger render={<UI.Button variant="secondary" />}>
              Inspect nested scope
            </UI.PopoverTrigger>
            <UI.PopoverContent>
              <UI.Button onClick={() => setAction('Nested scope inspected')}>
                Inspect scope locally
              </UI.Button>
            </UI.PopoverContent>
          </UI.Popover>
          <UI.Combobox
            items={['main', 'feature/quiet-graph']}
            onValueChange={(value) => setAction(`Nested branch: ${value}`)}
          >
            <UI.ComboboxInput aria-label="Nested branch" placeholder="Find a branch" />
            <UI.ComboboxContent>
              <UI.ComboboxList>
                {(item: string) => (
                  <UI.ComboboxItem key={item} value={item}>
                    {item}
                  </UI.ComboboxItem>
                )}
              </UI.ComboboxList>
            </UI.ComboboxContent>
          </UI.Combobox>
          <UI.ContextMenu>
            <UI.ContextMenuTrigger className="rounded border p-3" tabIndex={0}>
              Nested branch actions
            </UI.ContextMenuTrigger>
            <UI.ContextMenuContent>
              <UI.ContextMenuItem onClick={() => setAction('Nested ref copied locally')}>
                Copy nested ref
              </UI.ContextMenuItem>
            </UI.ContextMenuContent>
          </UI.ContextMenu>
          <output aria-live="polite">{action}</output>
          <UI.DialogFooter>
            <UI.DialogClose render={<UI.Button variant="secondary" />}>
              Close inspection
            </UI.DialogClose>
          </UI.DialogFooter>
        </UI.DialogContent>
      </UI.Dialog>
    )
  },
  'alert-dialog': function Confirm() {
    const [result, setResult] = useState('Nothing deleted')
    const [open, setOpen] = useState(false)
    return (
      <>
        <UI.AlertDialog open={open} onOpenChange={setOpen}>
          <UI.AlertDialogTrigger render={<UI.Button variant="danger" />}>
            Simulate branch deletion
          </UI.AlertDialogTrigger>
          <UI.AlertDialogContent>
            <UI.AlertDialogHeader>
              <UI.AlertDialogTitle>Delete local example branch?</UI.AlertDialogTitle>
              <UI.AlertDialogDescription>
                Simulate deleting <code>feature/quiet-graph</code> from this example. Only this
                specimen changes; no Git operation will run.
              </UI.AlertDialogDescription>
            </UI.AlertDialogHeader>
            <UI.AlertDialogFooter>
              <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
              <UI.AlertDialogAction
                variant="danger"
                onClick={() => {
                  setResult('Simulated deletion of feature/quiet-graph. No Git operation ran.')
                  setOpen(false)
                }}
              >
                Simulate deletion
              </UI.AlertDialogAction>
            </UI.AlertDialogFooter>
          </UI.AlertDialogContent>
        </UI.AlertDialog>
        <output aria-live="polite">{result}</output>
      </>
    )
  },
  sheet: () => (
    <UI.Sheet>
      <UI.SheetTrigger render={<UI.Button variant="secondary" />}>
        Open inspector sheet
      </UI.SheetTrigger>
      <UI.SheetContent>
        <UI.SheetHeader>
          <UI.SheetTitle>Captured operation scope</UI.SheetTitle>
          <UI.SheetDescription>Local examples only.</UI.SheetDescription>
        </UI.SheetHeader>
        <p className="p-4">feature/quiet-graph → fix/focus-return</p>
        <UI.SheetClose render={<UI.Button variant="secondary" />}>Close inspector</UI.SheetClose>
      </UI.SheetContent>
    </UI.Sheet>
  ),
  drawer: () => (
    <UI.Drawer>
      <UI.DrawerTrigger render={<UI.Button variant="secondary" />}>
        Open review drawer
      </UI.DrawerTrigger>
      <UI.DrawerContent>
        <UI.DrawerHeader>
          <UI.DrawerTitle>Review summary</UI.DrawerTitle>
          <UI.DrawerDescription>Local example. Drag or Escape to dismiss.</UI.DrawerDescription>
        </UI.DrawerHeader>
        <p className="p-4">1 unresolved conversation; checks unavailable.</p>
        <UI.DrawerFooter>
          <UI.DrawerClose render={<UI.Button variant="secondary" />}>Close review</UI.DrawerClose>
        </UI.DrawerFooter>
      </UI.DrawerContent>
    </UI.Drawer>
  ),
  popover: () => (
    <UI.Popover>
      <UI.PopoverTrigger render={<UI.Button variant="secondary" />}>
        Edit local scope
      </UI.PopoverTrigger>
      <UI.PopoverContent>
        <UI.Field id="popover-base" label="Base branch">
          <UI.Input defaultValue="main" />
        </UI.Field>
        <p>Changes stay in this local example. Escape dismisses.</p>
      </UI.PopoverContent>
    </UI.Popover>
  ),
  'hover-card': () => (
    <UI.HoverCard>
      <UI.HoverCardTrigger render={<a href="#git-compositions" />}>
        feature/quiet-graph
      </UI.HoverCardTrigger>
      <UI.HoverCardContent>
        <h3>Ada · PR #41</h3>
        <p>Inspection only. Checked-out branch remains main.</p>
      </UI.HoverCardContent>
    </UI.HoverCard>
  ),
  tooltip: () => (
    <UI.Tooltip>
      <UI.TooltipTrigger render={<UI.Button variant="secondary" />}>
        Inspect shortcut
      </UI.TooltipTrigger>
      <UI.TooltipContent>Inspect branch · Enter</UI.TooltipContent>
    </UI.Tooltip>
  ),
  attachment: function Attachment() {
    const [state, setState] = useState<'idle' | 'uploading' | 'processing' | 'error' | 'done'>(
      'done',
    )
    const [removed, setRemoved] = useState(false)
    return (
      <>
        <UI.Select
          aria-label="Attachment state"
          value={state}
          onValueChange={(value) => setState(value as typeof state)}
          options={['idle', 'uploading', 'processing', 'error', 'done'].map((value) => ({
            value,
            label: value,
          }))}
        />
        {removed ? (
          <>
            <p>Example attachment removed locally.</p>
            <UI.Button onClick={() => setRemoved(false)}>Restore attachment</UI.Button>
          </>
        ) : (
          <UI.Attachment state={state} aria-busy={state === 'uploading' || state === 'processing'}>
            <UI.AttachmentMedia>
              {state === 'uploading' || state === 'processing' ? (
                <UI.Spinner />
              ) : (
                <FileDiff aria-hidden="true" />
              )}
            </UI.AttachmentMedia>
            <UI.AttachmentContent>
              <UI.AttachmentTitle>quiet-graph.patch</UI.AttachmentTitle>
              <UI.AttachmentDescription>
                {state === 'error'
                  ? 'Local example failed — retry available'
                  : `Local example · 2.4 KB · ${state}`}
              </UI.AttachmentDescription>
            </UI.AttachmentContent>
            <UI.AttachmentActions>
              {state === 'error' && (
                <UI.AttachmentAction onClick={() => setState('uploading')}>
                  Retry locally
                </UI.AttachmentAction>
              )}
              <UI.AttachmentAction
                aria-label="Remove local attachment"
                onClick={() => setRemoved(true)}
              >
                <X aria-hidden="true" />
              </UI.AttachmentAction>
            </UI.AttachmentActions>
          </UI.Attachment>
        )}
      </>
    )
  },
  bubble: function Bubbles() {
    const [align, setAlign] = useState<'start' | 'end'>('start')
    return (
      <>
        <UI.Button
          variant="secondary"
          onClick={() => setAlign(align === 'start' ? 'end' : 'start')}
        >
          Align bubbles to {align === 'start' ? 'end' : 'start'}
        </UI.Button>
        <UI.BubbleGroup>
          {(
            ['default', 'secondary', 'muted', 'tinted', 'outline', 'ghost', 'destructive'] as const
          ).map((variant) => (
            <UI.Bubble key={variant} variant={variant} align={align}>
              <UI.BubbleContent>
                {variant}: keep inspection and checkout independent.
              </UI.BubbleContent>
            </UI.Bubble>
          ))}
        </UI.BubbleGroup>
      </>
    )
  },
  message: function Message() {
    const [reply, setReply] = useState(false)
    return (
      <UI.Message>
        <UI.MessageAvatar>
          <UI.Avatar>
            <UI.AvatarFallback>AD</UI.AvatarFallback>
          </UI.Avatar>
        </UI.MessageAvatar>
        <UI.MessageContent>
          <UI.MessageHeader>Ada · 10 October 2026, 09:30 UTC</UI.MessageHeader>
          <UI.Bubble>
            <UI.BubbleContent>Checks unavailable is not the same as passing.</UI.BubbleContent>
          </UI.Bubble>
          <UI.MessageFooter>
            <UI.Button variant="ghost" onClick={() => setReply(!reply)}>
              Reply locally
            </UI.Button>
          </UI.MessageFooter>
          {reply && <UI.Textarea aria-label="Local reply" placeholder="Write a local reply" />}
        </UI.MessageContent>
      </UI.Message>
    )
  },
  'message-scroller': () => (
    <UI.MessageScrollerProvider>
      <UI.MessageScroller className="h-52">
        <UI.MessageScrollerViewport>
          <UI.MessageScrollerContent>
            {Array.from({ length: 12 }, (_, index) => (
              <UI.MessageScrollerItem key={index} className="p-3" scrollAnchor={index === 11}>
                Ada: local review comment {index + 1}. Inspect the captured branch facts.
              </UI.MessageScrollerItem>
            ))}
          </UI.MessageScrollerContent>
        </UI.MessageScrollerViewport>
        <UI.MessageScrollerButton aria-label="Jump to latest comment" />
      </UI.MessageScroller>
    </UI.MessageScrollerProvider>
  ),
  marker: () => (
    <UI.Marker>
      <UI.MarkerIcon>
        <GitBranch aria-hidden="true" />
      </UI.MarkerIcon>
      <UI.MarkerContent>Lin restacked the local example · 09:45 UTC</UI.MarkerContent>
    </UI.Marker>
  ),
  questionnaire: function Questionnaire() {
    const [submitted, setSubmitted] = useState(false)
    return (
      <>
        <UI.Questionnaire
          items={[
            { name: 'scope', required: true, choices: [{ value: 'branch' }, { value: 'chain' }] },
            { name: 'notes' },
          ]}
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(true)
          }}
        >
          <UI.QuestionnaireItem name="scope" required>
            <UI.QuestionnaireTitle>Choose the local review scope</UI.QuestionnaireTitle>
            <UI.QuestionnaireChoices>
              <UI.QuestionnaireChoice value="branch">One branch</UI.QuestionnaireChoice>
              <UI.QuestionnaireChoice value="chain">Dependent branches</UI.QuestionnaireChoice>
            </UI.QuestionnaireChoices>
          </UI.QuestionnaireItem>
          <UI.QuestionnaireItem name="notes">
            <UI.QuestionnaireTitle>Review notes</UI.QuestionnaireTitle>
            <UI.QuestionnaireInput aria-label="Review notes" />
          </UI.QuestionnaireItem>
          <UI.QuestionnaireActions>
            <UI.QuestionnairePrevious />
            <UI.QuestionnaireNext />
            <UI.QuestionnaireSubmit>Save local answers</UI.QuestionnaireSubmit>
          </UI.QuestionnaireActions>
        </UI.Questionnaire>
        <output aria-live="polite">
          {submitted ? 'Answers saved in this local specimen only.' : 'No answers submitted.'}
        </output>
      </>
    )
  },
}
