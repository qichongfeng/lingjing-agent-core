export {
  FakeProvider,
  scriptedProvider,
  loopTrapProvider,
  textTurn,
  toolCallTurn,
  multiToolCallTurn,
  textAndToolTurn,
  pauseTurn,
  cweTurn,
  failingThenRecover,
} from "./fake-provider.js";
export type { FakeScript } from "./fake-provider.js";
export { echoTool, failTool, slowTool, addTool } from "./stub-tools.js";
export {
  allowGate,
  denyGate,
  modifyingGate,
  recordingHooks,
  vetoingHook,
  inputRewritingHook,
} from "./gate-helpers.js";
export type { RecordedHook } from "./gate-helpers.js";
