import { useState } from 'react'
import * as UI from '@git-stacks/ui'
import { BarChart, Bar, XAxis, CartesianGrid } from 'recharts'
import tokens from '@git-stacks/ui/tokens.json'

const rows = [
  { branch: 'feature/quiet-graph', author: 'Ada', checks: 'Unavailable' },
  { branch: 'fix/focus-return', author: 'Lin', checks: 'Passing' },
]
export const displaySpecimens = {
  card: () => (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle>Branch inspection</UI.CardTitle>
        <UI.CardDescription>Local example, independent of checkout.</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <code>feature/quiet-graph</code>
      </UI.CardContent>
      <UI.CardFooter>
        <UI.Button render={<a href="#git-compositions" />}>Inspect composition</UI.Button>
      </UI.CardFooter>
    </UI.Card>
  ),
  badge: () => (
    <div className="design-specimen-row">
      {(
        [
          'secondary',
          'outline',
          'accent',
          'info',
          'success',
          'warning',
          'danger',
          'merged',
        ] as const
      ).map((variant) => (
        <UI.Badge key={variant} variant={variant}>
          {variant}
        </UI.Badge>
      ))}
    </div>
  ),
  avatar: () => (
    <div className="design-specimen-row">
      <UI.Avatar>
        <UI.AvatarFallback>AD</UI.AvatarFallback>
      </UI.Avatar>
      <UI.Avatar>
        <UI.AvatarFallback>LN</UI.AvatarFallback>
      </UI.Avatar>
      <span>Ada and Lin — initials without remote image requests</span>
    </div>
  ),
  table: () => (
    <UI.Table>
      <UI.TableCaption>Local branch facts</UI.TableCaption>
      <UI.TableHeader>
        <UI.TableRow>
          <UI.TableHead>Branch</UI.TableHead>
          <UI.TableHead>Author</UI.TableHead>
          <UI.TableHead>Checks</UI.TableHead>
        </UI.TableRow>
      </UI.TableHeader>
      <UI.TableBody>
        {rows.map((row) => (
          <UI.TableRow key={row.branch}>
            <UI.TableCell>
              <code>{row.branch}</code>
            </UI.TableCell>
            <UI.TableCell>{row.author}</UI.TableCell>
            <UI.TableCell>{row.checks}</UI.TableCell>
          </UI.TableRow>
        ))}
      </UI.TableBody>
    </UI.Table>
  ),
  'data-table': function Table() {
    const [empty, setEmpty] = useState(false)
    return (
      <>
        <UI.Button variant="secondary" onClick={() => setEmpty(!empty)}>
          Toggle empty results
        </UI.Button>
        <UI.DataTable
          columns={[
            { accessorKey: 'branch', header: 'Branch' },
            { accessorKey: 'author', header: 'Author' },
            { accessorKey: 'checks', header: 'Checks' },
          ]}
          data={empty ? [] : rows}
        />
      </>
    )
  },
  item: () => (
    <UI.Item variant="outline">
      <UI.ItemContent>
        <UI.ItemTitle>Preserve independent inspection</UI.ItemTitle>
        <UI.ItemDescription>feature/quiet-graph · Ada · checks unavailable</UI.ItemDescription>
      </UI.ItemContent>
      <UI.ItemActions>
        <UI.Button render={<a href="#git-compositions" />} variant="secondary">
          Inspect
        </UI.Button>
      </UI.ItemActions>
    </UI.Item>
  ),
  accordion: () => (
    <UI.Accordion>
      <UI.AccordionItem value="checks">
        <UI.AccordionTrigger>Why are checks unavailable?</UI.AccordionTrigger>
        <UI.AccordionContent>
          No remote check facts are loaded. Unavailable does not mean passing.
        </UI.AccordionContent>
      </UI.AccordionItem>
      <UI.AccordionItem value="scope">
        <UI.AccordionTrigger>What is the operation scope?</UI.AccordionTrigger>
        <UI.AccordionContent>Only the captured local example branches.</UI.AccordionContent>
      </UI.AccordionItem>
    </UI.Accordion>
  ),
  collapsible: () => (
    <UI.Collapsible>
      <UI.CollapsibleTrigger render={<UI.Button variant="secondary" />}>
        Show captured preview
      </UI.CollapsibleTrigger>
      <UI.CollapsibleContent>
        <pre className="design-code">git diff main...feature/quiet-graph</pre>
        <p>Display only — never executed.</p>
      </UI.CollapsibleContent>
    </UI.Collapsible>
  ),
  chart: () => (
    <>
      <UI.ChartContainer
        config={{
          reviews: {
            label: 'Reviews',
            theme: {
              light: tokens.primitive.color['selection-strong'],
              dark: tokens.primitive.dark.color['selection-strong'],
            },
          },
        }}
        className="h-52 w-full"
      >
        <BarChart
          accessibilityLayer
          data={[
            { day: 'Mon', reviews: 3 },
            { day: 'Tue', reviews: 5 },
            { day: 'Wed', reviews: 2 },
          ]}
        >
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" />
          <UI.ChartTooltip content={<UI.ChartTooltipContent />} />
          <Bar dataKey="reviews" fill="var(--color-reviews)" />
        </BarChart>
      </UI.ChartContainer>
      <p>Illustrative reviews: Monday 3, Tuesday 5, Wednesday 2.</p>
    </>
  ),
  'aspect-ratio': () => (
    <div className="max-w-sm">
      <UI.AspectRatio ratio={16 / 9} className="flex items-center justify-center bg-muted">
        <code>16 : 9 graph preview</code>
      </UI.AspectRatio>
    </div>
  ),
  carousel: () => (
    <UI.Carousel className="mx-12 max-w-md">
      <UI.CarouselContent>
        {['Inspect', 'Capture scope', 'Confirm locally'].map((name, index) => (
          <UI.CarouselItem key={name}>
            <div className="p-8">
              <h3>{name}</h3>
              <p>Local example step {index + 1} of 3.</p>
            </div>
          </UI.CarouselItem>
        ))}
      </UI.CarouselContent>
      <UI.CarouselPrevious />
      <UI.CarouselNext />
    </UI.Carousel>
  ),
  resizable: () => (
    <UI.ResizablePanelGroup orientation="horizontal" className="min-h-40 rounded border">
      <UI.ResizablePanel defaultSize="35%" minSize="15%">
        <div className="p-4">Branches</div>
      </UI.ResizablePanel>
      <UI.ResizableHandle withHandle />
      <UI.ResizablePanel defaultSize="65%" minSize="20%">
        <div className="p-4">Primary inspection</div>
      </UI.ResizablePanel>
    </UI.ResizablePanelGroup>
  ),
  'scroll-area': () => (
    <UI.ScrollArea
      className="h-40 rounded border"
      tabIndex={0}
      aria-label="Scrollable commit history"
    >
      <div className="p-4">
        {Array.from({ length: 20 }, (_, index) => (
          <p key={index}>
            <code>{(index + 1).toString(16).padStart(7, '0')}</code> Local commit {index + 1}
          </p>
        ))}
      </div>
    </UI.ScrollArea>
  ),
  separator: () => (
    <div>
      Branch metadata
      <UI.Separator className="my-4" />
      Operation scope
    </div>
  ),
  direction: function Direction() {
    const [rtl, setRtl] = useState(false)
    return (
      <>
        <UI.Button variant="secondary" onClick={() => setRtl(!rtl)}>
          Switch to {rtl ? 'LTR' : 'RTL'}
        </UI.Button>
        <UI.Direction direction={rtl ? 'rtl' : 'ltr'}>
          <div dir={rtl ? 'rtl' : 'ltr'} className="p-4">
            Branch <code>feature/quiet-graph</code> — اتجاه النص
          </div>
        </UI.Direction>
      </>
    )
  },
  alert: () => (
    <UI.Alert variant="destructive">
      <UI.AlertTitle>Captured preview expired</UI.AlertTitle>
      <UI.AlertDescription>
        Capture a fresh local preview before confirming the operation.
      </UI.AlertDescription>
    </UI.Alert>
  ),
  empty: () => (
    <UI.Empty>
      <UI.EmptyHeader>
        <UI.EmptyTitle>No branches match</UI.EmptyTitle>
        <UI.EmptyDescription>
          Clear the filter to view the local example branches.
        </UI.EmptyDescription>
      </UI.EmptyHeader>
      <UI.EmptyContent>
        <UI.Button render={<a href="#git-compositions" />}>View branch examples</UI.Button>
      </UI.EmptyContent>
    </UI.Empty>
  ),
  progress: function Progress() {
    const [value, setValue] = useState(35)
    return (
      <>
        <UI.Progress value={value} aria-label="Local fetch progress" />
        <output>{value}% complete</output>
        <UI.Button variant="secondary" onClick={() => setValue((value + 25) % 101)}>
          Advance local progress
        </UI.Button>
      </>
    )
  },
  spinner: () => (
    <div role="status" className="design-specimen-row">
      <UI.Spinner />
      Loading local example facts
    </div>
  ),
  skeleton: () => (
    <div aria-busy="true" aria-label="Loading branch facts">
      <div aria-hidden="true" className="grid gap-3">
        <UI.Skeleton className="h-5 w-3/4" />
        <UI.Skeleton className="h-5 w-1/2" />
      </div>
      <p>Loading — not empty.</p>
    </div>
  ),
  toast: () => (
    <UI.Toaster>
      <UI.Button
        onClick={() =>
          UI.toast.add({
            title: 'Local simulation complete',
            description: 'No Git or GitHub operation was performed.',
            type: 'success',
          })
        }
      >
        Show local notification
      </UI.Button>
    </UI.Toaster>
  ),
}
