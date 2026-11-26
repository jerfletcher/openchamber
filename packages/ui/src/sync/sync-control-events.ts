import { type SyncEvent } from "@/lib/opencode/events"
import type { ControlStreamSyncEvent } from "@/lib/openchamberEvents"
import { applyWaitingPageEvent } from "./global-blocking-requests"
import { applySessionAssistEvent } from "./pending-session-assists"
import { applyAcpPermissionEvents } from "./acp-permissions"
import { applyAcpConfigEvents } from "./acp-config"
import { useWorkflowRunsStore } from "@/lib/workflows/store"
import { resolveCachedSessionDirectory } from "./event-routing-index"
import { notifyAcpPermission, notifyWaitingPage } from "./sync-request-notifications"

type ControlStreamOnlyEvent = Exclude<ControlStreamSyncEvent, { type: "session.patched" }>

export const isControlStreamOnlyEvent = (payload: SyncEvent): payload is ControlStreamOnlyEvent => (
  payload.type === "openchamber.page-waiting"
  || payload.type === "openchamber.page-settled"
  || payload.type === "openchamber.session-assist"
  || payload.type === "openchamber.workflow-run"
  || payload.type === "openchamber.workflow-run-removed"
  || payload.type === "openchamber.acp-permission-asked"
  || payload.type === "openchamber.acp-permission-settled"
  || payload.type === "openchamber.acp-plan"
  || payload.type === "openchamber.acp-mode"
  || payload.type === "openchamber.acp-config-options"
  || payload.type === "openchamber.acp-commands"
)

export const applyControlStreamOnlyEvent = (payload: ControlStreamOnlyEvent): void => {
  switch (payload.type) {
    case "openchamber.page-waiting":
    case "openchamber.page-settled":
      applyWaitingPageEvent(payload, resolveCachedSessionDirectory)
      if (payload.type === "openchamber.page-waiting") notifyWaitingPage(payload)
      return
    case "openchamber.session-assist":
      applySessionAssistEvent(payload.properties, resolveCachedSessionDirectory)
      return
    case "openchamber.workflow-run":
      useWorkflowRunsStore.getState().apply(payload.properties.run)
      return
    case "openchamber.workflow-run-removed":
      useWorkflowRunsStore.getState().remove(payload.properties.parentSessionId, payload.properties.runId)
      return
    // An ACP agent is blocked until the user answers, so the prompt is kept in
    // its own store (the session need not be open) and cleared when it settles.
    case "openchamber.acp-permission-asked":
    case "openchamber.acp-permission-settled":
      applyAcpPermissionEvents([payload])
      if (payload.type === "openchamber.acp-permission-asked") notifyAcpPermission(payload)
      return
    case "openchamber.acp-plan":
    case "openchamber.acp-mode":
    case "openchamber.acp-config-options":
    case "openchamber.acp-commands":
      applyAcpConfigEvents([payload])
      return
  }
}
