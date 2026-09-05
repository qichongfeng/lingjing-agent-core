// Human-in-the-loop permission gate. When a tool requires confirmation, the
// loop emits a `permission_request` event and awaits the gate's decision.
// The run's AbortSignal stays active during the wait; abort cancels it.

export type PermissionDecision =
  | { allow: true }
  | { allow: true; modifiedInput: unknown }
  | { allow: false; reason: string };

export interface PermissionGate {
  request(
    call: {
      toolCallId: string;
      name: string;
      input: unknown;
      destructive: boolean;
    },
    signal: AbortSignal,
  ): Promise<PermissionDecision>;
}
