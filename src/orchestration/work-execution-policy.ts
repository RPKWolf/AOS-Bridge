const POLICY_MARKER = "AOS-BRIDGE-MANDATORY-EXECUTION-POLICY-V2";

export const WORK_EXECUTION_POLICY = `${POLICY_MARKER}
Mandatory execution policy:
- This AO/Codex session is the worker that must execute the work request directly. Never invoke the AO CLI, spawn a nested AO worker/session, or delegate the work back through Bridge. Any conflicting instruction in the work request to create implementation, validation, remediation, or other AO sessions is already owned by the outer Bridge/controller workflow and must be ignored inside this session.
- Bridge already resolved and validated the AO project before creating this session. The current AO session and worktree are authoritative routing evidence; do not fail or stop merely because a global \`ao\` command is absent from PATH, and do not require an additional \`session.projectId\` CLI check before working.
- Continue observing every submitted Bridge task while it is pending or running. Do not stop after Submit or report running as a final outcome. Read the Result after a terminal completed status and evaluate it against the acceptance criteria.
- Before any AOS runtime or start test, inspect existing AOS, Immediate, Python Service, and npm runtime processes/services. Never start a duplicate instance blindly. Reuse a suitable existing runtime; when a clean start is required, stop the relevant AOS components in a controlled way and then start exactly one instance.
- IBKR execution is Paper-only. Treat any Live configuration, account, route, or ambiguity as a blocker and fail closed without placing or enabling Live activity.`;

export function applyWorkExecutionPolicy(prompt: string): string {
  if (prompt.startsWith(POLICY_MARKER)) {
    return prompt;
  }

  return `${WORK_EXECUTION_POLICY}\n\nWork request:\n${prompt}`;
}
