/**
 * Component manifest for Git Stacks — The Quiet Workbench Design System.
 * Dated: 2026-10-10
 * Reconciled explicitly against the public shadcn/ui Base UI catalog (base-nova).
 * Checked by CI via scripts/check-manifest.mjs.
 */

export interface ComponentManifestEntry {
  id: string
  name: string
  group:
    | 'Actions'
    | 'Navigation'
    | 'Forms'
    | 'Data display'
    | 'Layout'
    | 'Feedback'
    | 'Overlays'
    | 'Conversation'
    | 'Foundations'
  summary: string
  anatomy: string
  keyboard: string
  tokens: string[]
  importExample: string
  upstreamDoc: string
  reconciledWith: string
  catalogOnlyNotice?: string
}

export const MANIFEST_DATE = '2026-10-10'
export const TOTAL_REQUIRED_COMPONENTS = 63

export const UPSTREAM_RECONCILIATION = {
  date: MANIFEST_DATE,
  catalog: 'https://ui.shadcn.com/docs/components',
  variant: 'Base UI / base-nova',
  inventory:
    'The upstream catalog contains the same 63 entries plus Typography; no required entries omitted or renamed.',
  adaptations: [
    'Existing desktop Button, Badge, Checkbox, Dialog, Dropdown Menu, Field, Hover Card, Input, Radio Group, Select, Textarea and Tooltip APIs are preserved, not replaced by generated defaults.',
    'Command uses cmdk; Calendar uses DayPicker; Chart uses Recharts; Carousel uses Embla; Resizable uses react-resizable-panels; Input OTP uses input-otp; conversation recipes use @shadcn/react where their upstream implementation requires it.',
    'Data Table adapts the TanStack recipe to installed v9 with string-record columns, sorting and pagination. Date Picker exposes an owned single-date convenience API. Direction is exported as Direction with an explicit direction prop.',
    'Typography adds canonical compact heading/body/label/metadata/code roles beside upstream content styles. Recipes use a soft rounded card system with solid neutral surfaces, ink primary actions, pastel microaccents, circular icon controls, and explicit spacing. Whitespace and tonal contrast separate groups; structural outlines are absent. Sparse diffuse shadows and secondary-card offsets support purposeful layers without changing operational workflows.',
    'Examples are catalog-only local simulations, not desktop product features or Git/GitHub transports.',
  ],
} as const

export const COMPONENT_MANIFEST: ComponentManifestEntry[] = [
  {
    id: 'button',
    name: 'Button',
    group: 'Actions',
    summary:
      'Primary, secondary, ghost, subtle, accent, danger, and link action triggers with loading and disabled tooltip support.',
    anatomy:
      'Button and IconButton wrap the Base UI Button; Tooltip explains disabled/loading controls.',
    keyboard:
      'Tab to focus, Space/Enter to activate, Esc dismisses tooltip hint. Coarse pointers receive 44px minimum target.',
    tokens: [
      'semantic.action.primary',
      'semantic.action.secondary',
      'semantic.radius.control',
      'semantic.focus.ring',
    ],
    importExample: "import { Button, IconButton } from '@git-stacks/ui/components/button'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/button',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'button-group',
    name: 'Button Group',
    group: 'Actions',
    summary:
      'Horizontal or vertical container that groups related buttons together with consistent connected borders and shared radius.',
    anatomy: 'ButtonGroup container, Button children, optional Separator',
    keyboard:
      'Tab visits each button; Space/Enter activates it. ButtonGroup itself does not add roving focus.',
    tokens: ['semantic.border.essential', 'semantic.radius.control'],
    importExample: "import { ButtonGroup } from '@git-stacks/ui/components/button-group'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/button-group',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'toggle',
    name: 'Toggle',
    group: 'Actions',
    summary: 'A two-state button that can be either on (pressed) or off.',
    anatomy: 'TogglePrimitive.Root with aria-pressed state',
    keyboard: 'Space or Enter to toggle pressed state, Tab to navigate.',
    tokens: ['semantic.action.primary', 'semantic.selection.background', 'semantic.radius.control'],
    importExample: "import { Toggle } from '@git-stacks/ui/components/toggle'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/toggle',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'toggle-group',
    name: 'Toggle Group',
    group: 'Actions',
    summary: 'A set of two-state buttons that can be toggled on or off singly or in multiples.',
    anatomy: 'ToggleGroup container with roving focus and item selection',
    keyboard:
      'orientation="horizontal" uses Left/Right; orientation="vertical" uses Up/Down. Space/Enter toggles selection.',
    tokens: ['semantic.surface.inset', 'semantic.radius.pill'],
    importExample:
      "import { ToggleGroup, ToggleGroupItem } from '@git-stacks/ui/components/toggle-group'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/toggle-group',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'kbd',
    name: 'Kbd',
    group: 'Actions',
    summary:
      'Inline keyboard shortcut indicator for commands, navigation hints, and modifier keys.',
    anatomy: 'kbd element with monospace font and subtle border frame',
    keyboard: 'Screen readers announce keyboard shortcuts via aria-keyshortcuts or text content.',
    tokens: ['semantic.font.mono', 'semantic.border.essential', 'semantic.surface.inset'],
    importExample: "import { Kbd } from '@git-stacks/ui/components/kbd'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/kbd',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'breadcrumb',
    name: 'Breadcrumb',
    group: 'Navigation',
    summary: 'Displays the hierarchical path to the current repository, ref, or file location.',
    anatomy: 'BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage',
    keyboard:
      "Tab navigates navigable breadcrumb links; aria-current='page' identifies the final item.",
    tokens: ['semantic.text.secondary', 'semantic.selection.text'],
    importExample:
      "import { Breadcrumb, BreadcrumbItem, BreadcrumbLink } from '@git-stacks/ui/components/breadcrumb'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/breadcrumb',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'sidebar',
    name: 'Sidebar',
    group: 'Navigation',
    summary:
      'Collapsible primary navigation shell organizing repository panes, stacks, and settings.',
    anatomy:
      'SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarMenu, SidebarFooter',
    keyboard:
      'Tab visits links and SidebarTrigger; Ctrl/⌘ B toggles collapse. Narrow viewports use a focus-managed Sheet.',
    tokens: ['semantic.surface.content', 'semantic.surface.inset', 'semantic.radius.item'],
    importExample:
      "import { Sidebar, SidebarContent, SidebarMenu } from '@git-stacks/ui/components/sidebar'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/sidebar',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'navigation-menu',
    name: 'Navigation Menu',
    group: 'Navigation',
    summary: 'Horizontal top-level navigation bar with dropdown panels and viewports.',
    anatomy:
      'NavigationMenu, NavigationMenuList, NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink',
    keyboard: 'Tab moves between triggers, Down arrow enters content, Esc returns to trigger.',
    tokens: ['semantic.surface.content', 'semantic.elevation.medium'],
    importExample:
      "import { NavigationMenu, NavigationMenuList, NavigationMenuItem } from '@git-stacks/ui/components/navigation-menu'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/navigation-menu',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'menubar',
    name: 'Menubar',
    group: 'Navigation',
    summary:
      'Desktop-native persistent menu bar providing quick access to repository, branch, and stack commands.',
    anatomy:
      'Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator, MenubarShortcut',
    keyboard:
      'Left/Right arrows move between top-level menus, Up/Down arrows navigate items, Enter activates, Esc closes.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.elevation.medium'],
    importExample:
      "import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem } from '@git-stacks/ui/components/menubar'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/menubar',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'dropdown-menu',
    name: 'Dropdown Menu',
    group: 'Navigation',
    summary:
      'Contextual menu triggered by a button presenting a list of actions or navigation destinations.',
    anatomy:
      'DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator',
    keyboard:
      'Down arrow opens menu, Up/Down arrows move focus, Enter activates item, Esc closes and returns focus to trigger.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.elevation.medium'],
    importExample:
      "import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@git-stacks/ui/components/dropdown-menu'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/dropdown-menu',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'context-menu',
    name: 'Context Menu',
    group: 'Navigation',
    summary:
      'Right-click or Shift+F10 contextual menu for branch rows, commit items, and diff hunks.',
    anatomy:
      'ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator',
    keyboard:
      'Right-click or Shift+F10 opens menu at pointer/element, arrow keys navigate items, Enter activates, Esc dismisses.',
    tokens: ['semantic.surface.content', 'semantic.elevation.medium'],
    importExample:
      "import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@git-stacks/ui/components/context-menu'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/context-menu',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'command',
    name: 'Command',
    group: 'Navigation',
    summary:
      'Fast, searchable command palette for quick branch search, stack operations, and navigation shortcuts.',
    anatomy:
      'Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut',
    keyboard:
      'Typing filters cmdk items; Up/Down moves selection and Enter activates. CommandDialog adds a Base UI dialog; this app binds Ctrl/⌘ K.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.elevation.large'],
    importExample:
      "import { Command, CommandInput, CommandList, CommandItem } from '@git-stacks/ui/components/command'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/command',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'tabs',
    name: 'Tabs',
    group: 'Navigation',
    summary:
      'Layered sections of content displayed one at a time, switching between view modes or review tabs.',
    anatomy:
      'Tabs, TabsList, TabsTrigger, TabsContent wrap Base UI tabs. TabsList supports default/line variants and controlSize="compact" | "standard" (default). Tabs supports horizontal/vertical orientation.',
    keyboard:
      'Left/Right arrows move between horizontal tabs; Up/Down move between vertical tabs. Tabs automatically activate panels or activate on Enter/Space with manual activation.',
    tokens: ['semantic.surface.inset', 'semantic.selection.background', 'semantic.radius.control'],
    importExample:
      "import { Tabs, TabsList, TabsTrigger, TabsContent } from '@git-stacks/ui/components/tabs'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/tabs',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'pagination',
    name: 'Pagination',
    group: 'Navigation',
    summary:
      'Page navigation bar with previous, next, page numbers, and ellipsis for large commit histories or PR lists.',
    anatomy:
      'Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis',
    keyboard: "Tab moves between page links, aria-current='page' identifies the active page.",
    tokens: ['semantic.border.essential', 'semantic.radius.control'],
    importExample:
      "import { Pagination, PaginationContent, PaginationItem, PaginationLink } from '@git-stacks/ui/components/pagination'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/pagination',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'field',
    name: 'Field',
    group: 'Forms',
    summary:
      'Form field composition associating visible label, required star, control, helper text, and validation error message.',
    anatomy: 'Field container, label element, control slot, description, error alert',
    keyboard:
      'Label links via htmlFor to control id, aria-describedby links description and error messages.',
    tokens: ['semantic.type.label-size', 'semantic.feedback.error-text'],
    importExample: "import { Field } from '@git-stacks/ui/components/field'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/field',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'label',
    name: 'Label',
    group: 'Forms',
    summary: 'Accessible form label associated with inputs, checkboxes, and form controls.',
    anatomy: 'Label primitive with peer-disabled styling and font weight',
    keyboard:
      'Clicking label transfers focus to target input; screen reader announces linked label.',
    tokens: ['semantic.type.label-size', 'semantic.text.primary'],
    importExample: "import { Label } from '@git-stacks/ui/components/label'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/label',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'input',
    name: 'Input',
    group: 'Forms',
    summary:
      'Single-line text input for branch names, commit titles, commit SHAs, and search filters.',
    anatomy: 'Input primitive with compact (36px) and standard (44px) heights',
    keyboard:
      'Tab to focus, Repository Blue border and 2px focus ring; aria-invalid signals validation failure.',
    tokens: ['semantic.border.essential', 'semantic.focus.ring', 'semantic.radius.control'],
    importExample: "import { Input } from '@git-stacks/ui/components/input'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/input',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'input-group',
    name: 'Input Group',
    group: 'Forms',
    summary:
      'Composite input with leading/trailing addons, inline buttons, prefix icons, and submit triggers.',
    anatomy: 'InputGroup, InputGroupAddon, InputGroupButton, InputGroupText',
    keyboard: 'Tab navigates through inputs and interactive addons sequentially.',
    tokens: ['semantic.border.essential', 'semantic.surface.inset'],
    importExample:
      "import { InputGroup, InputGroupAddon } from '@git-stacks/ui/components/input-group'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/input-group',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'textarea',
    name: 'Textarea',
    group: 'Forms',
    summary:
      'Multi-line text editor for commit extended descriptions, review comments, and PR summaries.',
    anatomy: 'Textarea with compact (min-h-20) and standard (min-h-24) density variants',
    keyboard:
      'Tab focuses the editor; native text editing and vertical resize remain available. aria-invalid signals validation failure.',
    tokens: ['semantic.border.essential', 'semantic.focus.ring', 'semantic.radius.control'],
    importExample: "import { Textarea } from '@git-stacks/ui/components/textarea'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/textarea',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'checkbox',
    name: 'Checkbox',
    group: 'Forms',
    summary: 'Control that toggles between checked, unchecked, and indeterminate (mixed) states.',
    anatomy: 'CheckboxPrimitive.Root, CheckboxPrimitive.Indicator, visible label and description',
    keyboard:
      "Space to toggle state, Tab to navigate; mixed state uses Minus icon and aria-checked='mixed'.",
    tokens: ['semantic.selection.border', 'semantic.radius.control'],
    importExample: "import { Checkbox } from '@git-stacks/ui/components/checkbox'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/checkbox',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'radio-group',
    name: 'Radio Group',
    group: 'Forms',
    summary: 'Mutually exclusive single-choice option group with accessible roving focus.',
    anatomy: 'RadioGroupPrimitive, RadioGroupItem, RadioPrimitive.Indicator',
    keyboard:
      'Arrow keys navigate and select options within the group, Tab moves to the next form field.',
    tokens: ['semantic.selection.border', 'semantic.radius.pill'],
    importExample:
      "import { RadioGroup, RadioGroupItem } from '@git-stacks/ui/components/radio-group'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/radio-group',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'switch',
    name: 'Switch',
    group: 'Forms',
    summary:
      'Binary toggle switch for enabling/disabling feature flags, automatic sync, and notifications.',
    anatomy: 'SwitchPrimitive.Root, SwitchPrimitive.Thumb with smooth translation',
    keyboard: 'Space or Enter to toggle switch, Tab to navigate.',
    tokens: ['semantic.action.primary', 'semantic.radius.pill'],
    importExample: "import { Switch } from '@git-stacks/ui/components/switch'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/switch',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'select',
    name: 'Select',
    group: 'Forms',
    summary:
      'Combobox-styled button select with portaled option list supporting empty string choices.',
    anatomy:
      'SelectPrimitive.Root, SelectPrimitive.Trigger, SelectPrimitive.Portal, SelectPrimitive.Popup, SelectPrimitive.Item',
    keyboard:
      'Space/Enter opens list, Up/Down arrows navigate items, Enter selects item, Esc closes.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.radius.control'],
    importExample: "import { Select } from '@git-stacks/ui/components/select'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/select',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'native-select',
    name: 'Native Select',
    group: 'Forms',
    summary: 'Lightweight styled native HTML select element for system forms and simple dropdowns.',
    anatomy: 'Styled select wrapper with chevron icon and standard focus ring',
    keyboard: 'Native platform select keyboard and accessibility behaviors.',
    tokens: ['semantic.border.essential', 'semantic.radius.control'],
    importExample: "import { NativeSelect } from '@git-stacks/ui/components/native-select'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/native-select',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'combobox',
    name: 'Combobox',
    group: 'Forms',
    summary:
      'Searchable select input with autocomplete, keyboard filter, chips, and suggestions popup.',
    anatomy:
      'Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty; optional ComboboxChips for multiple values.',
    keyboard: 'Typing filters items, Down arrow enters list, Enter selects, Esc dismisses.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.radius.item'],
    importExample:
      "import { Combobox, ComboboxInput, ComboboxItem } from '@git-stacks/ui/components/combobox'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/combobox',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'slider',
    name: 'Slider',
    group: 'Forms',
    summary:
      'Interactive range slider for numerical values such as font scale, zoom level, or diff context lines.',
    anatomy:
      'Slider composes Base UI Root, Control, Track, Indicator and Thumb; provide its accessible name.',
    keyboard:
      'Left/Down arrows decrease value, Right/Up arrows increase value, Home/End jump to min/max.',
    tokens: ['semantic.action.primary', 'semantic.surface.inset', 'semantic.radius.pill'],
    importExample: "import { Slider } from '@git-stacks/ui/components/slider'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/slider',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    group: 'Forms',
    summary:
      'Accessible interactive month calendar for picking commit date ranges and review schedules.',
    anatomy:
      'DayPicker root with custom quiet workbench chevrons, day cells, month dropdowns, and range selection',
    keyboard:
      'Arrow keys navigate days within month, PageUp/PageDown switch months, Enter selects date.',
    tokens: ['semantic.surface.content', 'semantic.selection.background', 'semantic.radius.item'],
    importExample: "import { Calendar } from '@git-stacks/ui/components/calendar'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/calendar',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'date-picker',
    name: 'Date Picker',
    group: 'Forms',
    summary:
      'Owned single-date picker recipe combining a formatted trigger, Base UI Popover and DayPicker calendar.',
    anatomy:
      'DatePicker accepts date, onDateChange, placeholder and disabled; internally composes Button, Popover and Calendar.',
    keyboard:
      'Button activates popup with Space/Enter, calendar is keyboard navigable, Esc closes.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.radius.control'],
    importExample: "import { DatePicker } from '@git-stacks/ui/components/date-picker'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/date-picker',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'input-otp',
    name: 'Input OTP',
    group: 'Forms',
    summary:
      'One-time password and verification code input with segmented slots and copy-paste handling.',
    anatomy: 'OTPInput root, InputOTPGroup, InputOTPSlot, InputOTPSeparator',
    keyboard:
      'Typing advances focus to next slot automatically, Backspace returns to previous, paste distributes digits.',
    tokens: ['semantic.border.essential', 'semantic.radius.control', 'semantic.font.mono'],
    importExample:
      "import { InputOTP, InputOTPGroup, InputOTPSlot } from '@git-stacks/ui/components/input-otp'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/input-otp',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'card',
    name: 'Card',
    group: 'Data display',
    summary:
      'Structured content container with header, title, description, content, and footer sections.',
    anatomy: 'Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter',
    keyboard: 'Presents grouped information; children receive keyboard focus in logical order.',
    tokens: ['semantic.surface.content', 'semantic.elevation.small', 'semantic.radius.workbench'],
    importExample:
      "import { Card, CardHeader, CardTitle, CardContent } from '@git-stacks/ui/components/card'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/card',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'badge',
    name: 'Badge',
    group: 'Data display',
    summary: 'Concise text label for Git states, PR lifecycle, checks, review status, and counts.',
    anatomy:
      'Badge span with variant (secondary, outline, accent, info, success, warning, danger, merged)',
    keyboard:
      'Presents text alongside optional icons; color is never the sole indicator of status.',
    tokens: [
      'semantic.radius.pill',
      'semantic.feedback.info-surface',
      'semantic.feedback.success-surface',
    ],
    importExample: "import { Badge } from '@git-stacks/ui/components/badge'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/badge',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'avatar',
    name: 'Avatar',
    group: 'Data display',
    summary: 'Author and reviewer representation with image and fallback initials.',
    anatomy: 'AvatarRoot, AvatarImage, AvatarFallback',
    keyboard:
      'Alt text on image, accessible initials announced by screen reader when image is absent.',
    tokens: ['semantic.surface.inset', 'semantic.radius.pill'],
    importExample:
      "import { Avatar, AvatarImage, AvatarFallback } from '@git-stacks/ui/components/avatar'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/avatar',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'table',
    name: 'Table',
    group: 'Data display',
    summary:
      'Semantic data table for commits, file listings, branch comparisons, and benchmark outputs.',
    anatomy:
      'Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption',
    keyboard: 'Standard semantic table elements accessible to screen reader table navigation keys.',
    tokens: ['semantic.border.decorative', 'semantic.surface.content'],
    importExample:
      "import { Table, TableHeader, TableRow, TableHead, TableCell } from '@git-stacks/ui/components/table'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/table',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'data-table',
    name: 'Data Table',
    group: 'Data display',
    summary:
      'Owned string-row table recipe using TanStack Table v9 for sorting, pagination and explicit empty results.',
    anatomy:
      'DataTable accepts columns ({accessorKey, header}), data (string-valued records) and emptyMessage; renders shared semantic Table parts.',
    keyboard:
      'Tab visits sortable header buttons and pagination actions; Space/Enter sorts or changes page. Cells remain semantic table cells, not grid focus targets.',
    tokens: ['semantic.surface.content', 'semantic.border.essential'],
    importExample: "import { DataTable } from '@git-stacks/ui/components/data-table'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/data-table',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'item',
    name: 'Item',
    group: 'Data display',
    summary:
      'Compact item row with leading media, title, metadata description, and trailing actions.',
    anatomy: 'Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions',
    keyboard:
      'Presents lists of branch rows, PR items, and stash entries with clean keyboard focus targets.',
    tokens: ['semantic.surface.content', 'semantic.border.decorative', 'semantic.radius.control'],
    importExample:
      "import { Item, ItemMedia, ItemContent, ItemTitle, ItemActions } from '@git-stacks/ui/components/item'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/item',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'accordion',
    name: 'Accordion',
    group: 'Data display',
    summary:
      'Vertically stacked disclosures where each item expands or collapses a section of content.',
    anatomy:
      'Accordion, AccordionItem, AccordionTrigger, AccordionContent; the trigger composes the Base UI header internally.',
    keyboard:
      'Up/Down arrows move between headers, Space/Enter expands/collapses panel, Home/End jump to first/last.',
    tokens: ['semantic.border.decorative', 'semantic.radius.control'],
    importExample:
      "import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@git-stacks/ui/components/accordion'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/accordion',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'collapsible',
    name: 'Collapsible',
    group: 'Data display',
    summary: 'Single interactive disclosure component to expand or collapse secondary details.',
    anatomy:
      'Collapsible, CollapsibleTrigger, CollapsibleContent wrap Base UI disclosure primitives.',
    keyboard: 'Space or Enter to toggle disclosure state, aria-expanded conveys current state.',
    tokens: ['semantic.surface.content', 'semantic.radius.control'],
    importExample:
      "import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@git-stacks/ui/components/collapsible'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/collapsible',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'chart',
    name: 'Chart',
    group: 'Data display',
    summary:
      'Responsive charts for performance metrics, branch stack velocity, and review activity.',
    anatomy:
      'ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent with ChartConfig. Per-series theme.light/theme.dark colors follow data-gs-theme overrides; System follows prefers-color-scheme.',
    keyboard:
      'Recharts accessibilityLayer enables keyboard chart navigation; provide a textual data equivalent because visual tooltips alone are insufficient.',
    tokens: [
      'semantic.selection.text',
      'semantic.feedback.success-text',
      'semantic.feedback.warning-text',
    ],
    importExample: "import { ChartContainer, ChartTooltip } from '@git-stacks/ui/components/chart'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/chart',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'aspect-ratio',
    name: 'Aspect Ratio',
    group: 'Layout',
    summary:
      'Displays media, graph previews, and visual cards within a fixed width-to-height ratio.',
    anatomy: 'AspectRatio container with CSS aspect-ratio calculation',
    keyboard: 'Maintains proportion across viewport resize without layout shift.',
    tokens: ['semantic.radius.control'],
    importExample: "import { AspectRatio } from '@git-stacks/ui/components/aspect-ratio'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/aspect-ratio',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'carousel',
    name: 'Carousel',
    group: 'Layout',
    summary:
      'Swipeable and keyboard-navigable horizontal carousel for slide decks and workflow steps.',
    anatomy: 'Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext with Embla',
    keyboard: 'Left/Right arrows change slide, Tab navigates interactive slide contents.',
    tokens: ['semantic.surface.content', 'semantic.radius.item'],
    importExample:
      "import { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from '@git-stacks/ui/components/carousel'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/carousel',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'resizable',
    name: 'Resizable',
    group: 'Layout',
    summary:
      'Keyboard-accessible split panels for three-pane workbench layout (sidebar, primary, inspector).',
    anatomy: 'ResizablePanelGroup, ResizablePanel, ResizableHandle with react-resizable-panels',
    keyboard:
      'Left/Right or Up/Down arrows move splitter handle, Home/End collapse or expand fully.',
    tokens: ['semantic.border.decorative', 'semantic.focus.ring'],
    importExample:
      "import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@git-stacks/ui/components/resizable'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/resizable',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'scroll-area',
    name: 'Scroll Area',
    group: 'Layout',
    summary: 'Custom styled scrollable container with quiet rounded scrollbars.',
    anatomy: 'ScrollArea composes Base UI viewport; ScrollBar composes scrollbar and thumb.',
    keyboard:
      'Supports native mouse wheel, trackpad momentum, and keyboard scrolling (PageUp, PageDown, arrows).',
    tokens: ['semantic.border.essential', 'semantic.radius.pill'],
    importExample: "import { ScrollArea, ScrollBar } from '@git-stacks/ui/components/scroll-area'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/scroll-area',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'separator',
    name: 'Separator',
    group: 'Layout',
    summary: 'Visual and accessible separator dividing sections, toolbars, and menu groups.',
    anatomy: 'SeparatorPrimitive.Root with horizontal or vertical orientation',
    keyboard: "role='separator' with aria-orientation announced to screen readers.",
    tokens: ['semantic.border.decorative'],
    importExample: "import { Separator } from '@git-stacks/ui/components/separator'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/separator',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'direction',
    name: 'Direction',
    group: 'Layout',
    summary:
      'Direction provider setting text direction (LTR or RTL) for the application or scoped subtrees.',
    anatomy: "Direction wraps Base UI DirectionProvider and accepts direction='ltr'|'rtl'.",
    keyboard:
      'Mirrors primitive navigation behavior. Set the corresponding HTML dir attribute for native text/layout; the provider does not create a DOM element.',
    tokens: ['semantic.font.sans'],
    importExample: "import { Direction } from '@git-stacks/ui/components/direction'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/direction',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'alert',
    name: 'Alert',
    group: 'Feedback',
    summary: 'Inline banner callout for operation outcomes, warnings, hints, and error alerts.',
    anatomy: 'Alert, AlertTitle, AlertDescription with variant (default, destructive)',
    keyboard: "role='status' for polite notifications or role='alert' for critical warnings.",
    tokens: [
      'semantic.feedback.error-surface',
      'semantic.feedback.error-text',
      'semantic.radius.control',
    ],
    importExample:
      "import { Alert, AlertTitle, AlertDescription } from '@git-stacks/ui/components/alert'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/alert',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'empty',
    name: 'Empty',
    group: 'Feedback',
    summary:
      'Empty-state container with dashed border for unpopulated repositories, branch filters, or empty stashes.',
    anatomy:
      'Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent; compose an action inside EmptyContent.',
    keyboard:
      'Static explanation is readable normally; Tab reaches the provided recovery link/button. Empty does not imply loading or unavailable data.',
    tokens: ['semantic.surface.inset', 'semantic.border.essential', 'semantic.radius.item'],
    importExample:
      "import { Empty, EmptyTitle, EmptyDescription } from '@git-stacks/ui/components/empty'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/empty',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'progress',
    name: 'Progress',
    group: 'Feedback',
    summary:
      'Progress bar displaying task completion status for background clone, fetch, or restack operations.',
    anatomy:
      'Progress composes Base UI Root, Track and Indicator; value and an accessible label describe progress.',
    keyboard:
      'aria-valuenow, aria-valuemin, aria-valuemax convey numeric progress percentage to assistive technology.',
    tokens: ['semantic.action.primary', 'semantic.surface.inset', 'semantic.radius.pill'],
    importExample: "import { Progress } from '@git-stacks/ui/components/progress'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/progress',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'spinner',
    name: 'Spinner',
    group: 'Feedback',
    summary:
      'Animated circular spinner indicating an active asynchronous task or working mutation.',
    anatomy:
      'Spinner forwards SVG props to a Lucide Loader2 with size-4 and animate-spin defaults.',
    keyboard:
      "The decorative SVG is aria-hidden; put visible busy text and role='status' or aria-busy on its owning region. Reduced motion preserves that text.",
    tokens: ['semantic.selection.border', 'semantic.motion.standard'],
    importExample: "import { Spinner } from '@git-stacks/ui/components/spinner'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/spinner',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'skeleton',
    name: 'Skeleton',
    group: 'Feedback',
    summary: 'Animated pulse placeholder mimicking content shape while data loads.',
    anatomy: 'Skeleton div with subtle pulse animation and matching token radius',
    keyboard:
      "aria-hidden='true' hides placeholder decoration from screen readers while aria-busy announces parent load.",
    tokens: ['semantic.surface.inset', 'semantic.radius.control'],
    importExample: "import { Skeleton } from '@git-stacks/ui/components/skeleton'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/skeleton',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'toast',
    name: 'Toast',
    group: 'Feedback',
    summary:
      'Transient or polite toast notification for background operation successes and settled mutations.',
    anatomy:
      'Toaster provides the manager and live viewport; toast.add({title, description, type}) creates notifications. Lower-level Toast parts are also exported.',
    keyboard:
      'Base UI live announcements accompany visible text. Tab reaches the Close toast button; persistent notices need an explicit dismissal path.',
    tokens: ['semantic.surface.content', 'semantic.elevation.large', 'semantic.radius.control'],
    importExample: "import { Toaster, toast } from '@git-stacks/ui/components/toast'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/toast',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'dialog',
    name: 'Dialog',
    group: 'Overlays',
    summary:
      'Modal dialog window that interrupts the workflow for operations, forms, and settings.',
    anatomy:
      'Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose',
    keyboard:
      'Base UI focus trap confines focus within modal, Esc closes nested popups before the modal, focus returns to initiating trigger control. Nested Popover, Combobox, and ContextMenu use the popover layer above the dialog.',
    tokens: [
      'semantic.surface.content',
      'semantic.border.essential',
      'semantic.elevation.large',
      'semantic.radius.workbench',
    ],
    importExample:
      "import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '@git-stacks/ui/components/dialog'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/dialog',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'alert-dialog',
    name: 'Alert Dialog',
    group: 'Overlays',
    summary:
      'Destructive confirmation dialog requiring explicit user confirmation before hazardous operations.',
    anatomy:
      'AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel',
    keyboard:
      'Base UI traps focus and handles safe dismissal; set initialFocus explicitly when a particular control must receive focus. The caller performs and settles the confirmed action.',
    tokens: [
      'semantic.feedback.error-surface',
      'semantic.feedback.error-text',
      'semantic.elevation.large',
    ],
    importExample:
      "import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogAction, AlertDialogCancel } from '@git-stacks/ui/components/alert-dialog'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/alert-dialog',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'sheet',
    name: 'Sheet',
    group: 'Overlays',
    summary:
      'Slide-out overlay drawer anchored to the side of the screen for secondary inspectors and diagnostics.',
    anatomy: 'Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription',
    keyboard: 'Focus trap inside sheet, Esc dismisses, focus returns to trigger.',
    tokens: ['semantic.surface.content', 'semantic.elevation.large', 'semantic.border.decorative'],
    importExample:
      "import { Sheet, SheetTrigger, SheetContent } from '@git-stacks/ui/components/sheet'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/sheet',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'drawer',
    name: 'Drawer',
    group: 'Overlays',
    summary: 'Bottom or side slide-over drawer with swipe-to-dismiss support and drag handle.',
    anatomy:
      'Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose; content composes portal, overlay and swipe handle.',
    keyboard: 'Keyboard navigable, touch swipe gestures, Esc dismisses, focus trapped while open.',
    tokens: ['semantic.surface.content', 'semantic.elevation.large', 'semantic.radius.workbench'],
    importExample:
      "import { Drawer, DrawerTrigger, DrawerContent } from '@git-stacks/ui/components/drawer'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/drawer',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'popover',
    name: 'Popover',
    group: 'Overlays',
    summary:
      'Rich floating panel anchored to a trigger control, displaying interactive content and controls.',
    anatomy:
      'Popover, PopoverTrigger, PopoverContent; content composes Base UI Portal, Positioner and Popup.',
    keyboard:
      'Tab moves into popover content, Esc closes popover and restores focus to trigger button.',
    tokens: ['semantic.surface.content', 'semantic.elevation.medium', 'semantic.border.essential'],
    importExample:
      "import { Popover, PopoverTrigger, PopoverContent } from '@git-stacks/ui/components/popover'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/popover',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'hover-card',
    name: 'Hover Card',
    group: 'Overlays',
    summary:
      'Hover-activated preview card for sighted users to inspect branch refs, author profiles, and commit details.',
    anatomy:
      'HoverCard, HoverCardTrigger, HoverCardContent; content composes Base UI Portal, Positioner and Popup.',
    keyboard:
      'Opens on hover with intentional delay, closes on mouse leave; keyboard users access underlying link directly.',
    tokens: ['semantic.surface.content', 'semantic.elevation.medium', 'semantic.radius.item'],
    importExample:
      "import { HoverCard, HoverCardTrigger, HoverCardContent } from '@git-stacks/ui/components/hover-card'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/hover-card',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'tooltip',
    name: 'Tooltip',
    group: 'Overlays',
    summary:
      'Concise tooltip popup that explains disabled control reasons, shortcuts, and icon buttons.',
    anatomy: 'TooltipProvider, Tooltip, TooltipTrigger, TooltipContent',
    keyboard:
      'Appears on hover or keyboard focus, links via aria-describedby, Esc dismisses immediately.',
    tokens: ['semantic.surface.content', 'semantic.text.inverse', 'semantic.elevation.medium'],
    importExample:
      "import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@git-stacks/ui/components/tooltip'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/tooltip',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'attachment',
    name: 'Attachment',
    group: 'Conversation',
    summary:
      'Card displaying a patch file, screenshot, or build artifact attached to a review thread or PR comment.',
    anatomy:
      'Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction; state is idle/uploading/processing/error/done.',
    keyboard:
      "Tab visits supplied actions; Space/Enter activates them. Loading/error descriptions remain explicit. This specimen's retry/removal affect only local examples.",
    tokens: ['semantic.surface.inset', 'semantic.border.essential', 'semantic.radius.control'],
    importExample:
      "import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction } from '@git-stacks/ui/components/attachment'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/attachment',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'bubble',
    name: 'Bubble',
    group: 'Conversation',
    summary:
      'Speech bubble message for author comments, automated bot notices, and code review suggestions.',
    anatomy:
      'BubbleGroup, Bubble, BubbleContent; variants default/secondary/muted/tinted/outline/ghost/destructive and align start/end.',
    keyboard:
      'Static bubbles are readable, not focus targets; BubbleContent can render a link/button when interaction is appropriate. Preserve a visible accessible name.',
    tokens: ['semantic.surface.inset', 'semantic.surface.content', 'semantic.radius.item'],
    importExample:
      "import { Bubble, BubbleContent, BubbleGroup } from '@git-stacks/ui/components/bubble'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/bubble',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'message',
    name: 'Message',
    group: 'Conversation',
    summary:
      'Conversation message row with avatar, author metadata, timestamp, content bubble, and actions.',
    anatomy:
      'Message, MessageAvatar, MessageHeader, MessageContent, MessageFooter; compose author/time text in the header and actions in the footer.',
    keyboard:
      'Tab visits the supplied reply action and local editor; static message content remains readable without focus.',
    tokens: ['semantic.text.primary', 'semantic.text.secondary', 'semantic.type.metadata-size'],
    importExample:
      "import { Message, MessageAvatar, MessageHeader, MessageContent, MessageFooter } from '@git-stacks/ui/components/message'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/message',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'message-scroller',
    name: 'Message Scroller',
    group: 'Conversation',
    summary:
      'Anchored conversation scroll recipe with a latest-message action; not a virtualized list.',
    anatomy:
      'MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton',
    keyboard: 'Scroll button provides jump-to-bottom action with aria-label.',
    tokens: ['semantic.action.primary', 'semantic.radius.pill'],
    importExample:
      "import { MessageScroller, MessageScrollerProvider, MessageScrollerButton } from '@git-stacks/ui/components/message-scroller'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/message-scroller',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'marker',
    name: 'Marker',
    group: 'Conversation',
    summary:
      'Labeled separator or inline status marker indicating force-push, rebase, restack, or review state change.',
    anatomy: 'Marker container with icon, line dividers, and text badge',
    keyboard: 'Screen readers read event timestamp and actor summary.',
    tokens: [
      'semantic.border.decorative',
      'semantic.text.secondary',
      'semantic.type.metadata-size',
    ],
    importExample: "import { Marker } from '@git-stacks/ui/components/marker'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/marker',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'questionnaire',
    name: 'Questionnaire',
    group: 'Conversation',
    summary:
      'Interactive multi-step questionnaire for onboarding, review triage, and diagnostic surveys.',
    anatomy:
      'Questionnaire, QuestionnaireItem, QuestionnaireTitle, QuestionnaireChoices, QuestionnaireChoice, QuestionnaireInput, QuestionnaireError, QuestionnaireActions, QuestionnairePrevious, QuestionnaireNext, QuestionnaireSubmit.',
    keyboard:
      'Tab visits choices and Next/Previous actions; Space/Enter selects or advances. Required answers block progression and report errors; optional input can be skipped.',
    tokens: ['semantic.surface.content', 'semantic.border.essential', 'semantic.radius.item'],
    importExample:
      "import { Questionnaire, QuestionnaireItem, QuestionnaireTitle, QuestionnaireChoices, QuestionnaireChoice, QuestionnaireActions, QuestionnaireNext, QuestionnairePrevious, QuestionnaireSubmit } from '@git-stacks/ui/components/questionnaire'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/questionnaire',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
  {
    id: 'typography',
    name: 'Typography',
    group: 'Foundations',
    summary:
      'Application typography hierarchy: headings, body, labels, metadata, monospace code, refs, OIDs, and tabular numerals.',
    anatomy:
      'Typography component with variant (h1, h2, h3, h4, p, blockquote, list, inlineCode, heading, body, label, metadata, code)',
    keyboard:
      'Semantic heading levels and text elements; monospace reserved for code, paths, refs, and OIDs.',
    tokens: [
      'semantic.font.sans',
      'semantic.font.mono',
      'semantic.type.heading-size',
      'semantic.type.body-size',
      'semantic.type.label-size',
      'semantic.type.metadata-size',
    ],
    importExample: "import { Typography } from '@git-stacks/ui/components/typography'",
    upstreamDoc: 'https://ui.shadcn.com/docs/components/typography',
    reconciledWith: 'shadcn Base UI catalog 2026-10-10; owned Quiet Workbench adaptation',
  },
]

export const MANIFEST_GROUPS = [
  'Actions',
  'Navigation',
  'Forms',
  'Data display',
  'Layout',
  'Feedback',
  'Overlays',
  'Conversation',
  'Foundations',
] as const
