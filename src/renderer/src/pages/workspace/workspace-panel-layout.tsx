import { PanelLeft, PanelRight } from 'lucide-react'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMediaQuery } from '@/hooks/useMediaQuery'

import { MobilePreviewSheet } from './MobilePreviewSheet'
import { PreviewPanel } from './PreviewPanel'
import type { RestoredPlanResponder } from './session-plan/SessionPlanSurfaces'

const PANEL_COLLAPSED_SIZE = 0
const PANEL_COLLAPSED_SIZE_CSS = `${PANEL_COLLAPSED_SIZE}%`
const PANEL_COLLAPSED_THRESHOLD = 0.1

const SIDEBAR_PANEL_DEFAULT_SIZE = 16
const SIDEBAR_PANEL_DEFAULT_SIZE_CSS = `${SIDEBAR_PANEL_DEFAULT_SIZE}%`
const SIDEBAR_PANEL_MIN_OPEN_SIZE = 16
const SIDEBAR_TOGGLE_RIGHT_INSET = 38

const PREVIEW_PANEL_DEFAULT_SIZE = 40
const PREVIEW_PANEL_DEFAULT_SIZE_CSS = `${PREVIEW_PANEL_DEFAULT_SIZE}%`
const PREVIEW_PANEL_MIN_OPEN_SIZE = 30
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
const PANEL_CONTENT_TRANSITION_MS = 150
const PANEL_CONTENT_TRANSITION_CLASS_NAME =
  'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none motion-reduce:transform-none'

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

type ResizablePanelState = 'open' | 'collapsed'

type TransitionedResizablePanelOptions = {
  panelState: ResizablePanelState
  defaultOpenSize: number
  minOpenSize: number
  requestVersion?: number
  onPanelStateChange: (state: ResizablePanelState) => void
  onPixelWidthChange?: (width: number) => void
  collapseFocusTargetRef: React.RefObject<HTMLButtonElement | null>
}

type TransitionedResizablePanel = {
  panelRef: React.RefObject<PanelImperativeHandle | null>
  separatorRef: React.RefObject<HTMLDivElement | null>
  minSize: string
  onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
}

// Owns the one-shot resize and content-transition lifecycle shared by the desktop side panels.
const useTransitionedResizablePanel = ({
  panelState,
  defaultOpenSize,
  minOpenSize,
  requestVersion = 0,
  onPanelStateChange,
  onPixelWidthChange,
  collapseFocusTargetRef
}: TransitionedResizablePanelOptions): TransitionedResizablePanel => {
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const separatorRef = useRef<HTMLDivElement | null>(null)
  const collapseTimerRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const transitionTargetRef = useRef<ResizablePanelState | null>(null)
  const lastOpenSizeRef = useRef(defaultOpenSize)
  const hasSyncedInitialSizeRef = useRef(false)

  const resizePanel = useCallback((targetSize: number): void => {
    const panel = panelRef.current
    if (!panel) return

    try {
      panel.resize(`${targetSize}%`)
    } catch {
      // react-resizable-panels can expose the handle before its layout is registered.
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const nextPanel = panelRef.current
        if (nextPanel !== panel) return

        try {
          nextPanel.resize(`${targetSize}%`)
        } catch {
          // A detached panel will be synchronized by the next state/layout pass.
        }
      })
    }
  }, [])

  const onResize = useCallback(
    (panelSize: PanelSize, previousPanelSize: PanelSize | undefined): void => {
      onPixelWidthChange?.(panelSize.inPixels)

      const isNearCollapsedSize = panelSize.asPercentage <= PANEL_COLLAPSED_THRESHOLD
      const transitionTarget = transitionTargetRef.current
      const isOpeningTransitionResize =
        transitionTarget === 'open' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage >= previousPanelSize.asPercentage)
      const isClosingTransitionResize =
        transitionTarget === 'collapsed' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage <= previousPanelSize.asPercentage)

      if (isNearCollapsedSize && isOpeningTransitionResize) return
      if (!isNearCollapsedSize && isClosingTransitionResize) return

      transitionTargetRef.current = null
      if (!isNearCollapsedSize) lastOpenSizeRef.current = panelSize.asPercentage

      if (isNearCollapsedSize && document.activeElement === separatorRef.current) {
        collapseFocusTargetRef.current?.focus()
      }

      onPanelStateChange(isNearCollapsedSize ? 'collapsed' : 'open')
    },
    [collapseFocusTargetRef, onPanelStateChange, onPixelWidthChange]
  )

  // Open layout is interactive immediately. Closing keeps layout stable only long enough for the
  // content fade, then collapses with one resize. A new request cancels the pending collapse.
  useLayoutEffect(() => {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current)
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    collapseTimerRef.current = null
    resizeFrameRef.current = null
    transitionTargetRef.current = panelState

    const hasSyncedInitialSize = hasSyncedInitialSizeRef.current
    hasSyncedInitialSizeRef.current = true

    if (panelState === 'collapsed') {
      const collapse = (): void => {
        collapseTimerRef.current = null
        resizePanel(PANEL_COLLAPSED_SIZE)
      }

      if (hasSyncedInitialSize && !prefersReducedMotion()) {
        collapseTimerRef.current = window.setTimeout(collapse, PANEL_CONTENT_TRANSITION_MS)
      } else {
        collapse()
      }
    } else {
      resizePanel(Math.max(lastOpenSizeRef.current, minOpenSize))
    }

    return () => {
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current)
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    }
  }, [minOpenSize, panelState, requestVersion, resizePanel])

  return {
    panelRef,
    separatorRef,
    minSize: panelState === 'collapsed' ? PANEL_COLLAPSED_SIZE_CSS : `${minOpenSize}%`,
    onResize
  }
}

type WorkspacePanelLayout = {
  isMobile: boolean
  mobileSidebar: {
    isOpen: boolean
    open: () => void
    close: () => void
  }
  sidebar: TransitionedResizablePanel & {
    state: ResizablePanelState
    defaultSize: string
    toggle: () => void
    // Shared between the sidebar header toggle (expanded) and the floating fallback (collapsed);
    // exactly one of them is mounted at a time, so React hands the ref over automatically.
    toggleRef: React.RefObject<HTMLButtonElement | null>
    toggleButton: React.ReactNode
  }
  preview: TransitionedResizablePanel & {
    state: ResizablePanelState
    defaultSize: string
    toggle: () => void
    collapse: () => void
    toggleButton: React.ReactNode
  }
}

type PreviewPanelLayoutPort = {
  state: ResizablePanelState
  openRequestVersion: number
  toggle: () => void
  syncState: (state: ResizablePanelState) => void
}

// Presents one layout contract to WorkspacePage across desktop and mobile surfaces.
const useWorkspacePanelLayout = (
  previewPort: PreviewPanelLayoutPort,
  mobileSidebarDialogRef: React.RefObject<HTMLDivElement | null>
): WorkspacePanelLayout => {
  const { t } = useTranslation()
  const [sidebarState, setSidebarState] = useState<ResizablePanelState>('open')
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null)
  const previewToggleRef = useRef<HTMLButtonElement | null>(null)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const mobileSidebarReturnFocusRef = useRef<HTMLElement | null>(null)
  const mobileSidebarWasOpenRef = useRef(false)
  // Latest sidebar width in pixels and a render-phase-independent mirror of the collapse state,
  // so the floating fallback can be positioned no matter which toggle instance holds the ref.
  const sidebarPixelWidthRef = useRef<number | null>(null)
  const sidebarStateRef = useRef(sidebarState)

  const rememberMobileSidebarReturnFocus = useCallback((): void => {
    const activeElement = document.activeElement
    mobileSidebarReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null
  }, [])
  const openMobileSidebar = useCallback((): void => {
    rememberMobileSidebarReturnFocus()
    setIsMobileSidebarOpen(true)
  }, [rememberMobileSidebarReturnFocus])
  const closeMobileSidebar = useCallback((): void => setIsMobileSidebarOpen(false), [])
  const toggleMobileSidebar = useCallback((): void => {
    if (!isMobileSidebarOpen) rememberMobileSidebarReturnFocus()
    setIsMobileSidebarOpen(!isMobileSidebarOpen)
  }, [isMobileSidebarOpen, rememberMobileSidebarReturnFocus])
  const toggleSidebar = useCallback(
    (): void => setSidebarState((state) => (state === 'collapsed' ? 'open' : 'collapsed')),
    []
  )
  const syncSidebarTogglePosition = useCallback((panelWidth: number): void => {
    sidebarPixelWidthRef.current = panelWidth
    // While expanded the toggle sits inline in the sidebar header; only the collapsed floating
    // fallback needs explicit positioning.
    if (sidebarStateRef.current !== 'collapsed') return
    const toggle = sidebarToggleRef.current
    if (toggle) toggle.style.left = `${Math.max(0, panelWidth - SIDEBAR_TOGGLE_RIGHT_INSET)}px`
  }, [])

  const sidebar = useTransitionedResizablePanel({
    panelState: sidebarState,
    defaultOpenSize: SIDEBAR_PANEL_DEFAULT_SIZE,
    minOpenSize: SIDEBAR_PANEL_MIN_OPEN_SIZE,
    onPanelStateChange: setSidebarState,
    onPixelWidthChange: syncSidebarTogglePosition,
    collapseFocusTargetRef: sidebarToggleRef
  })

  const [initialPreviewDefaultSize] = useState(() =>
    previewPort.state === 'collapsed' ? PANEL_COLLAPSED_SIZE_CSS : PREVIEW_PANEL_DEFAULT_SIZE_CSS
  )
  const preview = useTransitionedResizablePanel({
    panelState: previewPort.state,
    defaultOpenSize: PREVIEW_PANEL_DEFAULT_SIZE,
    minOpenSize: PREVIEW_PANEL_MIN_OPEN_SIZE,
    requestVersion: previewPort.openRequestVersion,
    onPanelStateChange: previewPort.syncState,
    collapseFocusTargetRef: previewToggleRef
  })

  useEffect(() => {
    sidebarStateRef.current = sidebarState
  }, [sidebarState])

  useEffect(() => {
    const dialog = mobileSidebarDialogRef.current
    if (isMobile && isMobileSidebarOpen) {
      mobileSidebarWasOpenRef.current = true
      dialog
        ?.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        ?.focus()
      return
    }

    if (!mobileSidebarWasOpenRef.current) return
    mobileSidebarWasOpenRef.current = false

    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      document.contains(activeElement) &&
      !dialog?.contains(activeElement)
    ) {
      return
    }

    const returnFocus = mobileSidebarReturnFocusRef.current
    mobileSidebarReturnFocusRef.current = null
    if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus()
  }, [isMobile, isMobileSidebarOpen, mobileSidebarDialogRef])

  // Drag-to-collapse emits its final zero-width resize while the header toggle still holds the
  // ref, so the freshly mounted floating fallback reapplies the tracked width on collapse.
  useLayoutEffect(() => {
    if (sidebarState !== 'collapsed') return
    const panelWidth = sidebarPixelWidthRef.current
    if (panelWidth === null) return
    const toggle = sidebarToggleRef.current
    if (toggle) toggle.style.left = `${Math.max(0, panelWidth - SIDEBAR_TOGGLE_RIGHT_INSET)}px`
  }, [sidebarState])

  // Each toggle handoff (header instance ↔ floating fallback) unmounts the previously focused
  // button, dropping focus to <body>. Restore it on the surviving instance unless focus
  // legitimately lives elsewhere (e.g. the composer when the shortcut collapses the panel).
  const previousSidebarStateRef = useRef(sidebarState)
  useEffect(() => {
    const previousSidebarState = previousSidebarStateRef.current
    previousSidebarStateRef.current = sidebarState
    if (previousSidebarState === sidebarState) return

    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      document.contains(activeElement)
    ) {
      return
    }
    sidebarToggleRef.current?.focus()
  }, [sidebarState])

  useEffect(() => {
    if (!isMobile || !isMobileSidebarOpen) return

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMobileSidebar()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeMobileSidebar, isMobile, isMobileSidebarOpen])

  useEffect(() => {
    const toggleSidebarFromShortcut = (event: KeyboardEvent): void => {
      const isMac = window.api?.platform === 'darwin'
      const hasBlockingDialog = Array.from(
        document.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR)
      ).some((dialog) => dialog !== mobileSidebarDialogRef.current)
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'b' ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        hasBlockingDialog
      ) {
        return
      }

      event.preventDefault()
      if (isMobile) toggleMobileSidebar()
      else toggleSidebar()
    }

    window.addEventListener('keydown', toggleSidebarFromShortcut)
    return () => window.removeEventListener('keydown', toggleSidebarFromShortcut)
  }, [isMobile, mobileSidebarDialogRef, toggleMobileSidebar, toggleSidebar])

  return {
    isMobile,
    mobileSidebar: {
      isOpen: isMobileSidebarOpen,
      open: openMobileSidebar,
      close: closeMobileSidebar
    },
    sidebar: {
      ...sidebar,
      state: sidebarState,
      defaultSize: SIDEBAR_PANEL_DEFAULT_SIZE_CSS,
      toggle: toggleSidebar,
      toggleRef: sidebarToggleRef,
      toggleButton: (
        <button
          ref={sidebarToggleRef}
          type="button"
          data-testid="workspace-sidebar-toggle"
          className="absolute top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-action-panel-toggle shadow-none hover:bg-surface-control-hover"
          style={{
            left: `calc(${SIDEBAR_PANEL_DEFAULT_SIZE_CSS} - ${SIDEBAR_TOGGLE_RIGHT_INSET}px)`
          }}
          aria-label={
            sidebarState === 'collapsed' ? t('Expand sidebar panel') : t('Collapse sidebar panel')
          }
          aria-expanded={sidebarState !== 'collapsed'}
          aria-controls="left-panel"
          aria-keyshortcuts={window.api?.platform === 'darwin' ? 'Meta+B' : 'Control+B'}
          title={
            sidebarState === 'collapsed' ? t('Expand sidebar panel') : t('Collapse sidebar panel')
          }
          onClick={toggleSidebar}
        >
          <PanelLeft className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
        </button>
      )
    },
    preview: {
      ...preview,
      state: previewPort.state,
      defaultSize: initialPreviewDefaultSize,
      toggle: previewPort.toggle,
      collapse: () => previewPort.syncState('collapsed'),
      toggleButton: (
        <button
          ref={previewToggleRef}
          type="button"
          data-testid="workspace-preview-toggle"
          className={`absolute right-2 top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg ${
            previewPort.state === 'collapsed'
              ? 'bg-transparent shadow-none text-action-panel-toggle hover:bg-surface-control-hover'
              : 'bg-primary/20 shadow-card backdrop-blur text-action-panel-toggle'
          }`}
          aria-label={
            previewPort.state === 'collapsed'
              ? t('Expand preview panel')
              : t('Collapse preview panel')
          }
          aria-expanded={previewPort.state !== 'collapsed'}
          aria-controls="right-panel"
          title={
            previewPort.state === 'collapsed'
              ? t('Expand preview panel')
              : t('Collapse preview panel')
          }
          onClick={previewPort.toggle}
        >
          <PanelRight className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
        </button>
      )
    }
  }
}

type WorkspacePanelLayoutProps = {
  hasPreviewItems: boolean
  isPreviewPresentationActive?: boolean
  restoredPlanResponder?: RestoredPlanResponder
  preview: PreviewPanelLayoutPort
  renderDesktopSidebar: (options: {
    sidebarToggle: {
      state: ResizablePanelState
      onToggle: () => void
    }
    sidebarToggleRef: React.RefObject<HTMLButtonElement | null>
  }) => React.ReactNode
  renderMobileSidebar: (options: { isOpen: boolean; close: () => void }) => React.ReactNode
  renderConversation: (options: {
    isPreviewPanelCollapsed: boolean
    togglePreviewPanel: () => void
    openMobileSidebar: () => void
  }) => React.ReactNode
}

// Adapts the controller to the desktop split view and mobile drawer/sheet without owning page data.
const WorkspacePanelLayout = ({
  hasPreviewItems,
  isPreviewPresentationActive = true,
  restoredPlanResponder,
  preview: previewPort,
  renderDesktopSidebar,
  renderMobileSidebar,
  renderConversation
}: WorkspacePanelLayoutProps): React.JSX.Element => {
  const { t } = useTranslation()
  const mobileSidebarDialogRef = useRef<HTMLDivElement | null>(null)
  const { isMobile, mobileSidebar, sidebar, preview } = useWorkspacePanelLayout(
    previewPort,
    mobileSidebarDialogRef
  )

  return (
    <>
      <div className="relative flex h-full">
        {mobileSidebar.isOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-[65] bg-black/45 md:hidden"
            aria-label={t('Close navigation')}
            tabIndex={-1}
            onClick={mobileSidebar.close}
          />
        ) : null}
        {isMobile ? (
          <FocusScope
            asChild
            loop={mobileSidebar.isOpen}
            trapped={mobileSidebar.isOpen}
            onMountAutoFocus={(event) => event.preventDefault()}
            onUnmountAutoFocus={(event) => event.preventDefault()}
          >
            <div
              ref={mobileSidebarDialogRef}
              role={mobileSidebar.isOpen ? 'dialog' : undefined}
              aria-modal={mobileSidebar.isOpen ? true : undefined}
              aria-label={mobileSidebar.isOpen ? t('Workspace navigation') : undefined}
              className="contents"
            >
              {renderMobileSidebar({
                isOpen: mobileSidebar.isOpen,
                close: mobileSidebar.close
              })}
            </div>
          </FocusScope>
        ) : null}
        <ResizablePanelGroup
          orientation="horizontal"
          aria-hidden={isMobile && mobileSidebar.isOpen ? true : undefined}
          inert={isMobile && mobileSidebar.isOpen ? true : undefined}
          className={isMobile ? 'min-w-0 flex-1' : '-mr-[10px] min-w-0 flex-1'}
        >
          {!isMobile ? (
            <>
              <ResizablePanel
                id="left-panel"
                panelRef={sidebar.panelRef}
                defaultSize={sidebar.defaultSize}
                minSize={sidebar.minSize}
                collapsible
                collapsedSize="0%"
                onResize={(panelSize, _panelId, previousPanelSize) =>
                  sidebar.onResize(panelSize, previousPanelSize)
                }
              >
                <div
                  data-testid="workspace-sidebar-content"
                  aria-hidden={sidebar.state === 'collapsed' ? true : undefined}
                  inert={sidebar.state === 'collapsed' ? true : undefined}
                  className={`size-full min-w-0 ${PANEL_CONTENT_TRANSITION_CLASS_NAME} ${
                    sidebar.state === 'collapsed'
                      ? 'pointer-events-none -translate-x-2 opacity-0'
                      : 'translate-x-0 opacity-100'
                  }`}
                >
                  {renderDesktopSidebar({
                    sidebarToggle: { state: sidebar.state, onToggle: sidebar.toggle },
                    sidebarToggleRef: sidebar.toggleRef
                  })}
                </div>
              </ResizablePanel>

              <ResizableHandle
                elementRef={sidebar.separatorRef}
                aria-label={t('Resize left panel')}
                disabled={sidebar.state === 'collapsed'}
                aria-hidden={sidebar.state === 'collapsed'}
                className={`before:left-auto before:right-full before:mr-[3px] before:translate-x-0 transition-opacity duration-150 ease-out ${
                  sidebar.state === 'collapsed' ? 'opacity-0' : 'opacity-100'
                }`}
              />
            </>
          ) : null}

          {renderConversation({
            isPreviewPanelCollapsed: preview.state === 'collapsed',
            togglePreviewPanel: preview.toggle,
            openMobileSidebar: mobileSidebar.open
          })}

          {!isMobile ? (
            <>
              <ResizableHandle
                elementRef={preview.separatorRef}
                aria-label={t('Resize right panel')}
                disabled={preview.state === 'collapsed'}
                aria-hidden={preview.state === 'collapsed'}
                className={`bg-border shadow-[1px_0_3px_rgba(30,28,24,0.08)] before:left-auto before:right-full before:mr-0.5 before:w-1 before:translate-x-0 transition-opacity duration-150 ease-out ${
                  preview.state === 'collapsed' ? 'opacity-0' : 'opacity-100'
                }`}
              />

              <PreviewPanel
                panelRef={preview.panelRef}
                defaultSize={preview.defaultSize}
                minSize={preview.minSize}
                onResize={preview.onResize}
                contentClassName={`${PANEL_CONTENT_TRANSITION_CLASS_NAME} ${
                  preview.state === 'collapsed'
                    ? 'pointer-events-none translate-x-2 opacity-0'
                    : 'translate-x-0 opacity-100'
                }`}
                restoredPlanResponder={restoredPlanResponder}
              />
            </>
          ) : null}
        </ResizablePanelGroup>
        {!isMobile && hasPreviewItems ? preview.toggleButton : null}
        {!isMobile && sidebar.state === 'collapsed' ? sidebar.toggleButton : null}
      </div>

      {isMobile ? (
        <MobilePreviewSheet
          open={isPreviewPresentationActive && preview.state === 'open'}
          onClose={preview.collapse}
          restoredPlanResponder={restoredPlanResponder}
        />
      ) : null}
    </>
  )
}

export { WorkspacePanelLayout }
