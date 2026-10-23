import { initialWorkbenchView, type WorkbenchViewState } from '../components/branch-workbench-model'

export type WorkbenchSurface = 'branches' | 'pull-requests' | 'attention' | 'activity' | 'review'
export interface RepositoryViewMemory {
  surface: WorkbenchSurface
  selectedId: string | null
  pullRequestId: string | null
  pullRequestPage: number
  pullRequestScroll: number
  pullRequestQuery: string
  pullRequestLifecycle: string
  pullRequestCursor: string | null
  reviewOrigin: {
    repositoryId: string
    surface: WorkbenchSurface
    selectedId?: string | null
    worktreeId?: string | null
    tab?: WorkbenchViewState['tab']
    pullRequestId?: string | null
  } | null
  view: WorkbenchViewState
}
const STORAGE_KEY = 'git-stacks-workbench-view-v1'
export function readWorkbenchMemory(): Record<string, RepositoryViewMemory> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const result: Record<string, RepositoryViewMemory> = {}
    for (const [id, item] of Object.entries(raw)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const value = item as Partial<RepositoryViewMemory>
      const view = value.view
      if (
        !view ||
        typeof view.query !== 'string' ||
        typeof view.filter !== 'string' ||
        !['all', 'with', 'without'].includes(view.scope) ||
        !Array.isArray(view.folded) ||
        !view.folded.every((fold) => typeof fold === 'string') ||
        !Number.isFinite(view.scroll)
      )
        continue
      result[id] = {
        surface:
          value.surface === 'pull-requests' || value.surface === 'review'
            ? value.surface
            : 'branches',
        selectedId: typeof value.selectedId === 'string' ? value.selectedId : null,
        pullRequestId: typeof value.pullRequestId === 'string' ? value.pullRequestId : null,
        pullRequestPage:
          typeof value.pullRequestPage === 'number' &&
          Number.isInteger(value.pullRequestPage) &&
          value.pullRequestPage >= 0
            ? value.pullRequestPage
            : 0,
        pullRequestScroll:
          typeof value.pullRequestScroll === 'number' &&
          Number.isFinite(value.pullRequestScroll) &&
          value.pullRequestScroll >= 0
            ? value.pullRequestScroll
            : 0,
        pullRequestQuery: typeof value.pullRequestQuery === 'string' ? value.pullRequestQuery : '',
        pullRequestLifecycle:
          typeof value.pullRequestLifecycle === 'string' &&
          ['all', 'open', 'draft', 'closed', 'merged'].includes(value.pullRequestLifecycle)
            ? value.pullRequestLifecycle
            : 'all',
        pullRequestCursor:
          typeof value.pullRequestCursor === 'string' && value.pullRequestCursor.length <= 2048
            ? value.pullRequestCursor
            : null,
        reviewOrigin:
          value.reviewOrigin &&
          typeof value.reviewOrigin.repositoryId === 'string' &&
          ['branches', 'pull-requests', 'attention', 'activity'].includes(
            value.reviewOrigin.surface,
          )
            ? {
                repositoryId: value.reviewOrigin.repositoryId,
                surface: value.reviewOrigin.surface,
                selectedId:
                  typeof value.reviewOrigin.selectedId === 'string'
                    ? value.reviewOrigin.selectedId
                    : null,
                worktreeId:
                  typeof value.reviewOrigin.worktreeId === 'string'
                    ? value.reviewOrigin.worktreeId
                    : null,
                pullRequestId:
                  typeof value.reviewOrigin.pullRequestId === 'string'
                    ? value.reviewOrigin.pullRequestId
                    : null,
                tab:
                  value.reviewOrigin.tab &&
                  ['overview', 'changes', 'checks', 'discussion'].includes(value.reviewOrigin.tab)
                    ? value.reviewOrigin.tab
                    : 'overview',
              }
            : null,
        view: {
          ...initialWorkbenchView,
          query: view.query,
          filter: view.filter,
          scope: view.scope,
          folded: view.folded,
          scroll: view.scroll,
          paneScroll:
            typeof view.paneScroll === 'number' &&
            Number.isFinite(view.paneScroll) &&
            view.paneScroll >= 0
              ? view.paneScroll
              : initialWorkbenchView.paneScroll,
          unfilteredScroll:
            typeof view.unfilteredScroll === 'number' &&
            Number.isFinite(view.unfilteredScroll) &&
            view.unfilteredScroll >= 0
              ? view.unfilteredScroll
              : undefined,
          unfilteredPage:
            typeof view.unfilteredPage === 'number' &&
            Number.isInteger(view.unfilteredPage) &&
            view.unfilteredPage >= 0
              ? view.unfilteredPage
              : undefined,
          page: Number.isInteger(view.page) && view.page >= 0 ? view.page : 0,
          tab: ['overview', 'changes', 'checks', 'discussion'].includes(view.tab)
            ? view.tab
            : 'overview',
          worktreeId: typeof view.worktreeId === 'string' ? view.worktreeId : null,
          refScope: view.refScope === 'local' || view.refScope === 'remote' ? view.refScope : 'all',
        },
      }
    }
    return result
  } catch {
    return {}
  }
}
export function saveWorkbenchMemory(memory: Record<string, RepositoryViewMemory>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
    return null
  } catch {
    return 'View restoration is unavailable because local view storage could not be written.'
  }
}
export const emptyRepositoryMemory: RepositoryViewMemory = {
  surface: 'branches',
  selectedId: null,
  pullRequestId: null,
  pullRequestPage: 0,
  pullRequestScroll: 0,
  pullRequestQuery: '',
  pullRequestLifecycle: 'all',
  pullRequestCursor: null,
  reviewOrigin: null,
  view: initialWorkbenchView,
}
