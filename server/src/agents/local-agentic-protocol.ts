// Re-export from shared protocol package so server imports remain unchanged.
export {
  LocalAgenticToolName,
  LocalAgenticToolCall,
  LocalAgenticFinal,
  LocalAgenticAction,
  LOCAL_AGENTIC_PROTOCOL_INSTRUCTIONS,
  LOCAL_AGENTIC_DEFAULTS,
  LOCAL_AGENTIC_DELEGATION_TOOLS,
  parseLocalAgenticAction,
  buildLocalAgenticTurnPrompt,
  compactJson,
  promptRequestsDelegation,
  runAgenticLoop,
} from "@arkestrator/protocol";
export type {
  ParsedLocalAgenticAction,
  LocalAgenticHistoryEntry,
  AgenticLoopConfig,
  AgenticLoopDeps,
  AgenticLoopResult,
  AgenticLoopLlmResponse,
  AgenticLoopToolResult,
  AgenticLoopCommandRecord,
} from "@arkestrator/protocol";
