// The team UI surface. Every component moved to src/ui/* in M6 WP-3; this file keeps the import path and
// exports the exact set it exported before the split (the bundler in build.mjs strips these re-exports).
export { CtxBar, Glyph, RECEIPT_STATUS_TEXT, TEAM, receiptSeverity } from './ui/atoms.mjs';
export {
  CommandPalette, ERROR_TEXT, commandFor, explainError, frozenReason, readOnlyViewer, resourceActions, retireAction, retireOperationId
} from './ui/commands.mjs';
export { CapacityDetail, NeedsYou, RuntimeStates, healthOf } from './ui/situation.mjs';
export { isCollapsed } from './ui/lanes.mjs';
export { Detail, MessagesView, ResourceView, ThreadView } from './ui/detail.mjs';
export { TeamPage } from './ui/page.mjs';
export { MemberFrame, RosterWrapper, SessionMini, TeamIcon, TeamPaneTab, TeamPaneTitle } from './ui/frames.mjs';
