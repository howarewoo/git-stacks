import * as React from 'react'
import { useForm, useSelector } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSettingsMutation } from '../lib/settings-query'
import { AlertCircle, Check } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { SegmentedControl } from './ui/segmented-control'
import { InlineAlert } from './ui/surface'
import { OperationFacts, WorkflowSection, type ContextFact } from './workflow-composition'
import { ShortcutEditor } from './shortcut-settings'
import {
  GITHUB_DEFAULT_HOST,
  MERGE_METHODS,
  PULL_STRATEGIES,
  THEMES,
  type AppSettings,
  type DiagnosticReport,
  type MergeMethod,
  type PullStrategy,
  type SettingsPatch,
  type SettingsSnapshot,
  type SupportBundlePreview,
  type ThemePreference,
} from '../../../shared/settings'
import type { ShortcutId } from '../../../shared/shortcuts'
import type { GitHubCliStatus } from '../../../shared/types'
import { UPDATE_CHANNELS, type UpdateChannel, type UpdateStatus } from '../../../shared/update'
import { CAPABILITY_STATE_LABELS, type GitHubHostStatus } from '../../../shared/host'
import { GitHubCliStatusSection } from './github-cli-status'
import { UpdateFacts, UpdateNotice } from './update-summary'
import {
  NOTIFICATION_CONSENT_POINTS,
  NOTIFICATION_CREDENTIAL_KIND,
  NOTIFICATION_CREDENTIAL_SCOPE,
} from '../../../shared/notifications'

const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase',
}

const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  'ff-only': 'Fast-forward only',
  merge: 'Merge commit',
  rebase: 'Rebase',
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

/** Seconds offered in the refresh control, or 0 for "only on request". */
const INTERVAL_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
  { value: '900', label: '15 min' },
] as const

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  desktop: {
    settings?: () => Promise<SettingsSnapshot>
    updateSettings?: (patch: SettingsPatch) => Promise<SettingsSnapshot>
    resetSettings?: () => Promise<SettingsSnapshot>
    diagnostics?: () => Promise<DiagnosticReport>
    supportBundlePreview?: () => Promise<SupportBundlePreview>
    exportSupportBundle?: (previewId: string) => Promise<{ path: string; bytes: number }>
    githubHostStatus?: () => Promise<GitHubHostStatus>
    updateStatus?: () => Promise<UpdateStatus>
    checkForUpdates?: () => Promise<UpdateStatus>
    downloadUpdate?: () => Promise<UpdateStatus>
    installUpdate?: () => Promise<UpdateStatus>
    cancelUpdate?: () => Promise<UpdateStatus>
    onUpdateStatus?: (listener: (status: UpdateStatus) => void) => () => void
  } | null
  cliStatus: GitHubCliStatus | null
  /**
   * The one fenced read every surface asks for. Settings does not read the CLI
   * for itself: a second read would be a second answer, taken at a different
   * moment and able to disagree with what the rest of the window is showing.
   */
  onReadCliStatus: () => void
  /** Every change is written through the main process, which owns the file. */
  onSettingsChange: (settings: SettingsSnapshot['settings']) => void
  shortcutBindings: Record<ShortcutId, string>
  onShortcutBindingsChange: (bindings: Record<ShortcutId, string>) => void
  onError: (message: string) => void
}

type Section =
  | 'cli'
  | 'github'
  | 'notifications'
  | 'git'
  | 'appearance'
  | 'privacy'
  | 'shortcuts'
  | 'updates'
  | 'diagnostics'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'cli', label: 'GitHub CLI' },
  { id: 'github', label: 'GitHub' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'git', label: 'Git' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

export function SettingsDialog({
  open,
  onOpenChange,
  desktop,
  cliStatus,
  onReadCliStatus,
  onSettingsChange,
  shortcutBindings,
  onShortcutBindingsChange,
  onError,
}: SettingsDialogProps) {
  const [section, setSection] = React.useState<Section>('cli')
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => desktop!.settings!(),
    enabled: false,
  })
  const snapshot = settingsQuery.data ?? null
  const diagnosticsQuery = useQuery({
    queryKey: ['settings-diagnostics'],
    queryFn: () => desktop!.diagnostics!(),
    enabled: false,
  })
  const bundleQuery = useQuery({
    queryKey: ['settings-support-bundle'],
    queryFn: () => desktop!.supportBundlePreview!(),
    enabled: false,
  })
  const hostKey = ['github-host-status', snapshot?.settings.github.host] as const
  const hostQuery = useQuery({
    queryKey: hostKey,
    queryFn: () => desktop!.githubHostStatus!(),
    enabled: false,
  })
  const report = diagnosticsQuery.data ?? null
  const bundle = bundleQuery.data ?? null
  const hostStatus = hostQuery.data ?? null
  const saveMutation = useSettingsMutation((patch: SettingsPatch) =>
    desktop!.updateSettings!(patch),
  )
  const resetMutation = useSettingsMutation(() => desktop!.resetSettings!())
  const exportMutation = useMutation({
    mutationFn: (id: string) => desktop!.exportSupportBundle!(id),
  })
  const updateMutation = useMutation({
    mutationFn: async ({
      step,
    }: {
      step: () => Promise<UpdateStatus | undefined> | undefined
      busyWhile: boolean
    }) => (await step()) ?? null,
  })
  const busy =
    resetMutation.isPending ||
    saveMutation.isPending ||
    exportMutation.isPending ||
    (updateMutation.isPending && updateMutation.variables?.busyWhile) ||
    diagnosticsQuery.isFetching ||
    bundleQuery.isFetching
  const writeLock = React.useRef(false)
  const form = useForm({
    defaultValues: {
      host: snapshot?.settings.github.host ?? '',
      editor: snapshot?.settings.git.editor ?? '',
      mergeTool: snapshot?.settings.git.mergeTool ?? '',
    },
    onSubmitMeta: { field: 'host' as 'host' | 'editor' | 'mergeTool' },
    onSubmit: async ({ value, meta }): Promise<void> => {
      const key = meta.field === 'host' ? 'github.host' : `git.${meta.field}`
      if (busy || locked(key)) return
      if (meta.field === 'host') {
        const wanted = value.host.trim() || GITHUB_DEFAULT_HOST
        const stored = await save({ github: { host: wanted } }, `GitHub host set to ${wanted}.`)
        await refreshHostStatus()
        if (stored && stored.github.host !== wanted)
          setMessage(`GitHub host set to ${stored.github.host}.`)
      } else {
        const program = value[meta.field].trim()
        await save(
          { git: { [meta.field]: program || null } },
          program
            ? `${meta.field === 'editor' ? 'Editor' : 'Merge tool'} set to ${program}.`
            : `${meta.field === 'editor' ? 'Editor' : 'Merge tool'} reset.`,
        )
      }
    },
  })
  const formSubmitting = useSelector(form.store, (state) => state.isSubmitting)
  const [message, setMessage] = React.useState<string | null>(null)
  const updateQuery = useQuery({
    queryKey: ['update-status'],
    queryFn: () => desktop!.updateStatus!(),
    enabled: false,
  })
  const updates = updateQuery.data ?? null

  /**
   * Every update step goes through main and the answer main gives back is what
   * is shown. The window never decides that a download finished or that an
   * install may run.
   */
  const runUpdate = React.useCallback(
    async (step: () => Promise<UpdateStatus | undefined> | undefined, busyWhile: boolean) => {
      if (!step) return
      if (busyWhile && writeLock.current) return
      if (busyWhile) writeLock.current = true
      try {
        const next = await updateMutation.mutateAsync({ step, busyWhile })
        if (next) {
          await queryClient.cancelQueries({ queryKey: ['update-status'] })
          queryClient.setQueryData(['update-status'], next)
        }
      } catch (value) {
        onError(value instanceof Error ? value.message : String(value))
      } finally {
        if (busyWhile) writeLock.current = false
      }
    },
    [onError, queryClient, updateMutation],
  )

  React.useEffect(() => {
    if (!open || section !== 'updates') return
    if (desktop?.updateStatus)
      void updateQuery
        .refetch({ throwOnError: true })
        .catch((value) => onError(value instanceof Error ? value.message : String(value)))
    return desktop?.onUpdateStatus?.((status) => {
      void queryClient
        .cancelQueries({ queryKey: ['update-status'] })
        .then(() => queryClient.setQueryData(['update-status'], status))
    })
  }, [desktop, open, queryClient, section])

  const refresh = React.useCallback(async () => {
    if (!desktop?.settings) return
    try {
      const next = await queryClient.fetchQuery({
        queryKey: ['settings'],
        staleTime: 0,
        queryFn: desktop.settings,
      })
      form.reset({
        host: next.settings.github.host,
        editor: next.settings.git.editor ?? '',
        mergeTool: next.settings.git.mergeTool ?? '',
      })
      onSettingsChange(next.settings)
      onShortcutBindingsChange(next.settings.shortcuts)
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    }
  }, [desktop, form, onError, onSettingsChange, onShortcutBindingsChange, queryClient])

  React.useEffect(() => {
    if (!open) return
    setMessage(null)
    void refresh()
  }, [open, refresh])

  /**
   * Writes a patch and leaves every field showing what was stored, which is not
   * always what was asked for: a value this build refuses leaves the previous
   * one in effect, and a host pasted as a URL is normalized down to its host
   * name. The stored settings are returned so a caller reports the host that is
   * in effect rather than the text it typed.
   */
  const save = React.useCallback(
    async (patch: SettingsPatch, note: string): Promise<AppSettings | null> => {
      if (!desktop?.updateSettings) return null
      if (writeLock.current) return null
      writeLock.current = true
      try {
        const next = await saveMutation.mutateAsync(patch)
        setMessage(note)
        form.reset({
          host: next.settings.github.host,
          editor: next.settings.git.editor ?? '',
          mergeTool: next.settings.git.mergeTool ?? '',
        })
        return next.settings
      } catch (value) {
        onError(value instanceof Error ? value.message : String(value))
        return null
      } finally {
        writeLock.current = false
      }
    },
    [desktop, form, onError, onSettingsChange, onShortcutBindingsChange, queryClient, saveMutation],
  )

  const lockFor = React.useCallback(
    (key: string) => snapshot?.locks.find((lock) => lock.key === key) ?? null,
    [snapshot],
  )
  const issueFor = React.useCallback(
    (key: string) => snapshot?.issues.find((issue) => issue.key === key) ?? null,
    [snapshot],
  )
  /**
   * The message a field shows. A lock is reported like a refusal rather than
   * left to a disabled control to imply, so the user learns what the policy
   * fixed instead of only noticing that the control will not move.
   */
  const problemFor = React.useCallback(
    (key: string, toolErrorMessage?: string | null) =>
      issueFor(key)?.message ?? toolErrorMessage ?? lockFor(key)?.reason ?? undefined,
    [issueFor, lockFor],
  )

  /**
   * What the host this installation points at actually supports. It is asked
   * for, not assumed: a host that has not answered is shown as unknown.
   */
  const refreshHostStatus = React.useCallback(async () => {
    if (!desktop?.githubHostStatus) return
    try {
      const host = queryClient.getQueryData<SettingsSnapshot>(['settings'])?.settings.github.host
      await queryClient.fetchQuery({
        queryKey: ['github-host-status', host],
        staleTime: 0,
        queryFn: desktop.githubHostStatus,
      })
    } catch {
      queryClient.setQueryData(hostKey, null)
    }
  }, [desktop, snapshot?.settings.github.host, queryClient])

  React.useEffect(() => {
    if (!open || section !== 'github') return
    void refreshHostStatus()
  }, [open, section, refreshHostStatus])

  const openDiagnostics = React.useCallback(async () => {
    if (!desktop?.diagnostics) return
    try {
      await diagnosticsQuery.refetch({ throwOnError: true })
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    }
  }, [desktop, diagnosticsQuery, onError])

  const previewBundle = React.useCallback(async () => {
    if (!desktop?.supportBundlePreview) return
    try {
      await bundleQuery.refetch({ throwOnError: true })
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    }
  }, [desktop, bundleQuery, onError])

  const exportBundle = React.useCallback(async () => {
    if (!desktop?.exportSupportBundle || !bundle?.id) return
    if (writeLock.current) return
    writeLock.current = true
    try {
      const result = await exportMutation.mutateAsync(bundle.id)
      setMessage(
        result.path
          ? `Support bundle written (${result.bytes} bytes).`
          : 'Support bundle export was cancelled.',
      )
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    } finally {
      writeLock.current = false
    }
  }, [desktop, bundle?.id, exportMutation, onError])

  // Reading the CLI status again is a real read of sanitized facts, and it is the
  // same read the rest of the window makes. Settings inspects that session; it
  // never changes it, so there is no sign-in, switch, or sign-out control here
  // and no control that could be mistaken for one.
  const refreshCliStatus = React.useCallback(() => {
    onReadCliStatus()
  }, [onReadCliStatus])

  const settings = snapshot?.settings
  const locked = (key: string) => lockFor(key) !== null

  const reportFacts: ContextFact[] = (report?.entries ?? []).map((entry) => ({
    label: `${entry.source} · ${entry.label}`,
    value: entry.detail ? `${entry.value} — ${entry.detail}` : entry.value,
    code: true,
  }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These preferences are stored on this computer and validated before they are used.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          <nav aria-label="Settings sections" className="grid w-44 shrink-0 content-start gap-1">
            {SECTIONS.map((entry) => (
              <Button
                key={entry.id}
                variant={section === entry.id ? 'secondary' : 'ghost'}
                size="sm"
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </nav>

          <div className="grid min-w-0 flex-1 content-start gap-4">
            {!snapshot ? <InlineAlert tone="info">Reading settings…</InlineAlert> : null}
            {message ? (
              <InlineAlert tone="success">
                <Check aria-hidden="true" className="size-4" /> {message}
              </InlineAlert>
            ) : null}
            {snapshot?.recovered ? (
              <InlineAlert tone="warning">
                The stored settings file could not be read, so defaults are in use. Saving replaces
                it.
              </InlineAlert>
            ) : null}

            {section === 'cli' && settings ? (
              <GitHubCliStatusSection
                onRefresh={() => void refreshCliStatus()}
                refreshing={busy}
                status={cliStatus}
              />
            ) : null}

            {section === 'github' && settings ? (
              <WorkflowSection label="GitHub host">
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void form.handleSubmit({ field: 'host' })
                  }}
                >
                  <form.Field name="host">
                    {(field) => (
                      <Field
                        id="settings-github-host"
                        label="Host"
                        description="The GitHub host this app works against. Leave it as github.com, or name your GitHub Enterprise Server host. CLI authentication status, every request, and every clone URL follow it."
                        error={problemFor('github.host')}
                      >
                        <Input
                          value={field.state.value}
                          placeholder={GITHUB_DEFAULT_HOST}
                          disabled={busy || formSubmitting || locked('github.host')}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy || formSubmitting || locked('github.host')}
                  >
                    Use this host
                  </Button>
                </form>
                {hostStatus ? (
                  <OperationFacts
                    facts={[
                      { label: 'Host', value: `${hostStatus.host} (${hostStatus.kind})` },
                      { label: 'REST base', value: hostStatus.apiBase },
                      {
                        label: 'Server version',
                        value: hostStatus.serverVersion ?? 'not reported by the host',
                      },
                      ...hostStatus.capabilities.map((capability) => ({
                        label: capability.label,
                        value: CAPABILITY_STATE_LABELS[capability.state],
                        detail: capability.detail,
                      })),
                    ]}
                  />
                ) : (
                  <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                    This host has not answered yet, so nothing is claimed about what it supports.
                  </p>
                )}
              </WorkflowSection>
            ) : null}

            {section === 'notifications' && settings ? (
              <WorkflowSection label="GitHub Notifications">
                <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                  The GitHub Notifications inbox is a different thing from the pull request inbox in
                  this app, and it is not read with the GitHub CLI session. It is off by default;
                  turning it on here says what it adds before you turn it on, and only then can a
                  token be authorized from the Notification Center.
                </p>
                <Field
                  id="settings-notifications"
                  label={<span className="sr-only">Read a GitHub Notifications inbox</span>}
                  description={`Optional and separate from CLI authentication. Reading this inbox needs a ${NOTIFICATION_CREDENTIAL_KIND} with the ${NOTIFICATION_CREDENTIAL_SCOPE} scope. It is entered here, crosses the bridge to the main process once, and is kept sealed by the operating system's own protection in a vault file this module owns; ordinary application state holds only an opaque reference to it, and the stored credential is never sent back to this window. Turning it off stops the polling and hides the list; it does not remove that token, it asks nothing of the GitHub CLI session, and it changes nothing about pull requests, stacks, or reviews.`}
                  error={problemFor('notifications.enabled')}
                >
                  <Checkbox
                    id="settings-notifications"
                    label="Read a GitHub Notifications inbox"
                    checked={settings.notifications.enabled}
                    disabled={busy || locked('notifications.enabled')}
                    onCheckedChange={(checked) =>
                      void save(
                        { notifications: { enabled: checked } },
                        checked
                          ? 'GitHub Notifications enabled. Authorize it from the Notification Center.'
                          : 'GitHub Notifications turned off. Its stored token is kept, and nothing else changed.',
                      )
                    }
                  />
                </Field>
                {lockFor('notifications.enabled') ? (
                  <InlineAlert tone="info">{lockFor('notifications.enabled')!.reason}</InlineAlert>
                ) : null}
                <p className="text-[length:var(--gs-semantic-type-label-size)]">
                  What authorizing one adds, in full
                </p>
                <ul className="m-0 grid list-none gap-2 p-0">
                  {NOTIFICATION_CONSENT_POINTS.map((point) => (
                    <li
                      className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]"
                      key={point}
                    >
                      {point}
                    </li>
                  ))}
                </ul>
              </WorkflowSection>
            ) : null}

            {section === 'git' && settings ? (
              <>
                <WorkflowSection label="Git runtime">
                  <Field
                    id="settings-use-system-git"
                    label="Git to run"
                    description="The bundled Git is the version this app was tested against. Choose system Git to use the copy installed on this computer."
                    error={problemFor('git.useSystemGit')}
                  >
                    <SegmentedControl
                      label="Git to run"
                      value={settings.git.useSystemGit ? 'system' : 'bundled'}
                      disabled={busy || locked('git.useSystemGit')}
                      options={[
                        { value: 'bundled', label: 'Bundled' },
                        { value: 'system', label: 'System' },
                      ]}
                      onValueChange={(value) =>
                        void save(
                          { git: { useSystemGit: value === 'system' } },
                          `Git set to the ${value} installation.`,
                        )
                      }
                    />
                  </Field>
                  {lockFor('git.useSystemGit') ? (
                    <InlineAlert tone="info">{lockFor('git.useSystemGit')!.reason}</InlineAlert>
                  ) : null}
                </WorkflowSection>

                <WorkflowSection label="Tools">
                  <form.Field name="editor">
                    {(field) => (
                      <Field
                        id="settings-editor"
                        label="Editor"
                        description="One program name, no arguments. Leave empty to use this platform's default application."
                        error={problemFor('git.editor', toolError(snapshot, 'editor'))}
                      >
                        <Input
                          value={field.state.value}
                          disabled={busy || formSubmitting || locked('git.editor')}
                          placeholder="platform default"
                          onChange={(event) => field.handleChange(event.target.value)}
                          onBlur={() => {
                            field.handleBlur()
                            void form.handleSubmit({ field: 'editor' })
                          }}
                        />
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="mergeTool">
                    {(field) => (
                      <Field
                        id="settings-merge-tool"
                        label="Merge tool"
                        description="One program name Git runs to resolve a conflict. Leave empty to use whatever Git is configured with."
                        error={problemFor('git.mergeTool', toolError(snapshot, 'mergeTool'))}
                      >
                        <Input
                          value={field.state.value}
                          disabled={busy || formSubmitting || locked('git.mergeTool')}
                          placeholder="Git's own configuration"
                          onChange={(event) => field.handleChange(event.target.value)}
                          onBlur={() => {
                            field.handleBlur()
                            void form.handleSubmit({ field: 'mergeTool' })
                          }}
                        />
                      </Field>
                    )}
                  </form.Field>
                </WorkflowSection>

                <WorkflowSection label="Defaults">
                  <Field
                    id="settings-pull-strategy"
                    label="Default pull strategy"
                    description="Used when a pull starts a stack update."
                    error={problemFor('git.defaultPullStrategy')}
                  >
                    <SegmentedControl
                      label="Default pull strategy"
                      value={settings.git.defaultPullStrategy}
                      disabled={busy || locked('git.defaultPullStrategy')}
                      options={PULL_STRATEGIES.map((value) => ({
                        value,
                        label: PULL_STRATEGY_LABELS[value],
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { defaultPullStrategy: value } },
                          `Default pull strategy set to ${PULL_STRATEGY_LABELS[value]}.`,
                        )
                      }
                    />
                  </Field>
                  <Field
                    id="settings-merge-method"
                    label="Default merge method"
                    description="Used when a completed pull request is folded into its parent."
                    error={problemFor('git.defaultMergeMethod')}
                  >
                    <SegmentedControl
                      label="Default merge method"
                      value={settings.git.defaultMergeMethod}
                      disabled={busy || locked('git.defaultMergeMethod')}
                      options={MERGE_METHODS.map((value) => ({
                        value,
                        label: MERGE_METHOD_LABELS[value],
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { defaultMergeMethod: value } },
                          `Default merge method set to ${MERGE_METHOD_LABELS[value]}.`,
                        )
                      }
                    />
                  </Field>
                  <Field
                    id="settings-fetch-interval"
                    label="Background refresh"
                    description="How often this app refreshes an open repository on its own. Off refreshes only when you ask."
                    error={problemFor('git.fetchIntervalSeconds')}
                  >
                    <SegmentedControl
                      label="Background refresh"
                      value={String(settings.git.fetchIntervalSeconds)}
                      disabled={busy || locked('git.fetchIntervalSeconds')}
                      options={INTERVAL_OPTIONS.map((entry) => ({
                        value: entry.value,
                        label: entry.label,
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { fetchIntervalSeconds: Number(value) } },
                          value === '0'
                            ? 'Background refresh turned off.'
                            : `Background refresh set to every ${value} seconds.`,
                        )
                      }
                    />
                  </Field>
                </WorkflowSection>
              </>
            ) : null}

            {section === 'appearance' && settings ? (
              <WorkflowSection label="Appearance">
                <Field
                  id="settings-theme"
                  label="Theme"
                  description="Match system follows this computer's appearance and keeps following it."
                  error={problemFor('appearance.theme')}
                >
                  <SegmentedControl
                    label="Theme"
                    value={settings.appearance.theme}
                    disabled={busy || locked('appearance.theme')}
                    options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
                    onValueChange={(value) =>
                      void save(
                        { appearance: { theme: value } },
                        `Theme set to ${THEME_LABELS[value]}.`,
                      )
                    }
                  />
                </Field>
                <Field
                  id="settings-reduce-motion"
                  label={<span className="sr-only">Reduce motion</span>}
                  description="Removes non-essential transitions, whether or not this computer's system asks for it."
                  error={problemFor('appearance.reduceMotion')}
                >
                  <Checkbox
                    id="settings-reduce-motion"
                    label="Reduce motion"
                    checked={settings.appearance.reduceMotion}
                    disabled={busy || locked('appearance.reduceMotion')}
                    onCheckedChange={(checked) =>
                      void save(
                        { appearance: { reduceMotion: checked } },
                        checked ? 'Motion reduced.' : 'Motion restored.',
                      )
                    }
                  />
                </Field>
              </WorkflowSection>
            ) : null}

            {section === 'updates' && settings ? (
              <>
                <WorkflowSection label="Updates">
                  <Field
                    id="settings-update-channel"
                    label="Channel"
                    description="Stable follows signed releases for everyone. Beta follows the pre-release channel, which moves faster and changes more often."
                    error={problemFor('updates.channel')}
                  >
                    <SegmentedControl
                      label="Channel"
                      value={settings.updates.channel}
                      disabled={busy || locked('updates.channel')}
                      options={UPDATE_CHANNELS.map((value) => ({
                        value,
                        label: value === 'stable' ? 'Stable' : 'Beta',
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { updates: { channel: value as UpdateChannel } },
                          `Following the ${value} channel.`,
                        )
                      }
                    />
                  </Field>
                  <UpdateFacts status={updates} channel={settings.updates.channel} />
                </WorkflowSection>
                <WorkflowSection label="This build">
                  <UpdateNotice status={updates} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={
                        busy || !desktop?.checkForUpdates || updates?.phase === 'not-configured'
                      }
                      onClick={() => void runUpdate(() => desktop?.checkForUpdates?.(), true)}
                    >
                      Check for updates
                    </Button>
                    <Button
                      disabled={busy || updates?.phase !== 'available' || !desktop?.downloadUpdate}
                      onClick={() => void runUpdate(() => desktop?.downloadUpdate?.(), false)}
                    >
                      {updates?.phase === 'downloading'
                        ? `Downloading ${updates.progress ?? 0}%`
                        : 'Download update'}
                    </Button>
                    <Button
                      disabled={busy || !updates?.readyToInstall || !desktop?.installUpdate}
                      onClick={() => void runUpdate(() => desktop?.installUpdate?.(), true)}
                    >
                      Install and restart
                    </Button>
                    {(updates?.phase === 'checking' || updates?.phase === 'downloading') &&
                    desktop?.cancelUpdate ? (
                      <Button
                        variant="secondary"
                        onClick={() => void runUpdate(() => desktop?.cancelUpdate?.(), false)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                </WorkflowSection>
              </>
            ) : null}

            {section === 'shortcuts' ? (
              <WorkflowSection label="Keyboard shortcuts">
                <ShortcutEditor
                  bindings={shortcutBindings}
                  // The active bindings follow the settings the main process
                  // confirmed, never the edit being offered: adopting first
                  // would leave a locked or refused change in force.
                  onBindingsChange={(bindings) => {
                    void save({ shortcuts: bindings }, 'Shortcuts saved.')
                  }}
                  disabledReason={lockFor('shortcuts')?.reason}
                />
              </WorkflowSection>
            ) : null}

            {section === 'privacy' && settings ? (
              <>
                <WorkflowSection label="What this app collects">
                  <InlineAlert tone="info">
                    This build sends nothing anywhere. There is no telemetry endpoint and no crash
                    upload, and no setting here turns one on. The only thing produced on this
                    computer is the support bundle below, which you write yourself.
                  </InlineAlert>
                </WorkflowSection>
                <WorkflowSection label="Support bundle">
                  <Field
                    id="settings-include-paths"
                    label={<span className="sr-only">Include local paths</span>}
                    description="Off by default. A local path names a username and a directory layout, which a bug report rarely needs. Turning this on adds the Git executable path to the bundle and nothing else — source, diffs, branch names, and pull request text are never included either way."
                    error={problemFor('privacy.includeLocalPaths')}
                  >
                    <Checkbox
                      id="settings-include-paths"
                      label="Include local paths"
                      checked={settings.privacy.includeLocalPaths}
                      disabled={busy || locked('privacy.includeLocalPaths')}
                      onCheckedChange={(checked) => {
                        void queryClient.resetQueries({ queryKey: ['settings-support-bundle'] })
                        void save(
                          { privacy: { includeLocalPaths: checked } },
                          checked
                            ? 'Local paths will be included in a support bundle.'
                            : 'Local paths will be withheld from a support bundle.',
                        )
                      }}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={busy} onClick={previewBundle}>
                      Preview bundle
                    </Button>
                    <Button disabled={busy || !bundle?.id} onClick={exportBundle}>
                      Create support bundle
                    </Button>
                  </div>
                  {bundle ? (
                    <OperationFacts
                      facts={bundle.sections.map((entry) => ({
                        label: entry.title,
                        value: entry.included ? entry.reason : `Not included: ${entry.reason}`,
                      }))}
                    />
                  ) : null}
                  {bundle
                    ? bundle.sections
                        .filter((entry) => entry.included)
                        .map((entry) => (
                          <details key={entry.id} className="grid gap-1">
                            <summary className="cursor-pointer text-[length:var(--gs-semantic-type-label-size)]">
                              {entry.title}
                            </summary>
                            <pre className="max-h-48 overflow-auto rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] p-2 text-[length:var(--gs-semantic-type-metadata-size)]">
                              {entry.content}
                            </pre>
                          </details>
                        ))
                    : null}
                </WorkflowSection>
              </>
            ) : null}

            {section === 'diagnostics' ? (
              <WorkflowSection label="Capability report">
                <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                  Every line below was measured on this computer by a fixed set of commands run in
                  the app process. A line marked unavailable is something this build could not
                  establish, not an assumption, and a line marked not applicable is one this build
                  never asked about. GitHub collaboration requires the GitHub CLI, so its detection
                  and authentication status are asked about rather than assumed, and a CLI version
                  on its own never establishes an account.
                </p>
                <Button variant="secondary" disabled={busy} onClick={openDiagnostics}>
                  Run report
                </Button>
                {report ? <OperationFacts facts={reportFacts} /> : null}
              </WorkflowSection>
            ) : null}

            {settings ? (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--gs-semantic-border)] pt-3">
                <span className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                  Stored in {snapshot?.file ?? 'application data'}
                </span>
                <Button
                  variant="secondary"
                  disabled={busy || !desktop?.resetSettings}
                  onClick={() => {
                    if (!desktop?.resetSettings || writeLock.current) return
                    writeLock.current = true
                    resetMutation
                      .mutateAsync()
                      .then((next) => {
                        form.reset({
                          host: next.settings.github.host,
                          editor: next.settings.git.editor ?? '',
                          mergeTool: next.settings.git.mergeTool ?? '',
                        })
                        setMessage('Settings restored to their defaults.')
                      })
                      .catch((value) =>
                        onError(value instanceof Error ? value.message : String(value)),
                      )
                      .finally(() => {
                        writeLock.current = false
                      })
                  }}
                >
                  <AlertCircle aria-hidden="true" className="size-4" /> Reset all
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Says a configured tool is missing here, where the name is typed. */
function toolError(
  snapshot: SettingsSnapshot | null,
  key: 'editor' | 'mergeTool',
): string | undefined {
  const tool = snapshot?.tools?.[key]
  if (!tool || tool.available) return undefined
  return tool.label === 'none configured'
    ? undefined
    : `${tool.label} is not installed on this computer.`
}
