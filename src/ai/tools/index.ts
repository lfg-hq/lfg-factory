// ── Tool Collections ──────────────────────────────────────────────────────────

export { getProjectDashboard, setProjectStack, captureProjectName } from "./project-tools.ts";

export {
  streamDocumentContent,
  getFileList,
  getFileContent,
  updateFileContent,
  patchFileContent,
  setWsBroadcast as setDocumentWsBroadcast,
} from "./document-tools.ts";

export {
  createTickets,
  getPendingTickets,
  getTicketDetails,
  updateTicket,
  updateTicketDetails,
  updateAllTickets,
  getNextTicket,
  scheduleTickets,
  retryTicket,
  sendTicketMessage,
  queueTicketExecution,
  setTicketWsBroadcast,
} from "./ticket-tools.ts";

export { getProjectEnvVars, registerRequiredEnvVars, setEnvVar, provisionPostgresDb } from "./env-tools.ts";

export {
  broadcastToUser,
  askUser,
  confirmAction,
  lookupTechnologySpecs,
  setWsBroadcast as setMiscWsBroadcast,
} from "./misc-tools.ts";

export { createInstantTools } from "./instant-tools.ts";

export { createBuilderTools } from "./builder-tools.ts";

export { queryCodebase } from "./codebase-tools.ts";

export { getRecentActivities } from "./activity-tools.ts";

// ── tools_product: Full product analyst toolset ───────────────────────────────
import { getProjectDashboard, setProjectStack, captureProjectName } from "./project-tools.ts";
import { streamDocumentContent, getFileList, getFileContent, updateFileContent, patchFileContent } from "./document-tools.ts";
import {
  createTickets, getPendingTickets, getTicketDetails,
  updateTicket, updateTicketDetails, updateAllTickets,
  getNextTicket, scheduleTickets, retryTicket, sendTicketMessage, queueTicketExecution,
} from "./ticket-tools.ts";
import { getProjectEnvVars, registerRequiredEnvVars, setEnvVar } from "./env-tools.ts";
import { broadcastToUser, askUser, confirmAction, lookupTechnologySpecs } from "./misc-tools.ts";
import { queryCodebase } from "./codebase-tools.ts";
import { getRecentActivities } from "./activity-tools.ts";

export const toolsProduct = {
  getProjectDashboard,
  setProjectStack,
  captureProjectName,
  streamDocumentContent,
  getFileList,
  getFileContent,
  updateFileContent,
  patchFileContent,
  createTickets,
  getPendingTickets,
  getTicketDetails,
  updateTicket,
  updateTicketDetails,
  updateAllTickets,
  getNextTicket,
  scheduleTickets,
  retryTicket,
  sendTicketMessage,
  queueTicketExecution,
  getProjectEnvVars,
  registerRequiredEnvVars,
  setEnvVar,
  // provisionPostgresDb — DISABLED: the shared provisioning server is unreachable
  // (ECONNREFUSED). Keeping the tool defined but unregistered so the product agent
  // can't call it during ticket creation. Re-add here to re-enable.
  lookupTechnologySpecs,
  broadcastToUser,
  askUser,
  confirmAction,
  queryCodebase,
  getRecentActivities,
};

// ── tools_turbo: Lightweight subset for quick interactions ────────────────────
export const toolsTurbo = {
  getProjectDashboard,
  getPendingTickets,
  getTicketDetails,
  updateTicket,
  sendTicketMessage,
  broadcastToUser,
};
