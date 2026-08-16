import type { OrchestratorAdapter } from "./orchestrator-adapter";
import {
  AoProtocolError,
  AoRequestError,
  TaskResultUnavailableError,
  UnsupportedAgentOrchestratorVersionError,
} from "../errors/bridge-error";
import type {
  TaskHandle,
  TaskRequest,
  TaskResult,
  TaskStatus,
} from "../types/task";

export interface AoRestAdapterOptions {
  baseUrl: string;
  /** @deprecated Kept for source compatibility only; never used for routing. */
  projectId?: string;
  harness: string;
  displayName: string;
  auditLogger?: (entry: ProjectRoutingAuditEntry) => void;
}

export interface ProjectRoutingAuditEntry {
  event: "project-routing-resolved";
  taskId: string;
  requestedProjectId?: string;
  resolvedProjectId: string;
  resolution: "explicit" | "single-eligible-fallback";
}

interface ConversationTurn {
  id: string;
  state: string;
}

interface ConversationMessage {
  turnId: string;
  role: string;
  streaming: boolean;
  sequence: number;
  text: string;
}

export class AoRestAdapter implements OrchestratorAdapter {
  private readonly resolvedProjects = new Map<string, string>();
  private readonly routingAudit = new Map<string, ProjectRoutingAuditEntry>();

  private constructor(private readonly options: AoRestAdapterOptions) {}

  public static async create(options: AoRestAdapterOptions): Promise<AoRestAdapter> {
    const adapter = new AoRestAdapter(options);
    await adapter.verifyCompatibility();

    return adapter;
  }

  public async submitTask(request: TaskRequest): Promise<TaskHandle> {
    const resolvedProjectId = await this.resolveProject(request);
    const sessionResponse = await this.fetchJson("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        projectId: resolvedProjectId,
        kind: "worker",
        mode: "chat",
        harness: this.options.harness,
        displayName: this.options.displayName,
      }),
    });
    const sessionId = this.getSessionId(sessionResponse);
    const messageResponse = await this.fetchJson(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          text: request.prompt,
          clientMessageId: request.id,
        }),
      },
    );
    const duplicate = this.getBoolean(messageResponse, "duplicate", "message response");
    const turnId = this.isRecord(messageResponse) ? messageResponse.turnId : undefined;
    if (typeof turnId !== "string" || turnId.trim().length === 0) {
      if (duplicate) {
        throw new AoProtocolError(
          "Duplicate AO message response did not include a usable turnId",
        );
      }

      throw new AoProtocolError("AO message response did not include a usable turnId");
    }

    return { sessionId, turnId };
  }

  public getRoutingAudit(taskId: string): ProjectRoutingAuditEntry | undefined {
    return this.routingAudit.get(taskId);
  }

  private async resolveProject(request: TaskRequest): Promise<string> {
    const projectsResponse = await this.fetchJson("/api/v1/projects");
    const projectIds = this.getArray(projectsResponse, "projects", "projects response")
      .map((project) => this.getString(project, "id", "project"));
    const requestedProjectId = request.routing?.projectId;
    let resolvedProjectId: string;
    let resolution: ProjectRoutingAuditEntry["resolution"];

    if (requestedProjectId !== undefined) {
      if (!projectIds.includes(requestedProjectId)) {
        throw new AoProtocolError(`AO project is not registered: ${requestedProjectId}`);
      }
      resolvedProjectId = requestedProjectId;
      resolution = "explicit";
    } else {
      if (projectIds.length !== 1) {
        throw new AoProtocolError(
          `Project routing requires exactly one eligible AO project; found ${projectIds.length}`,
        );
      }
      resolvedProjectId = projectIds[0];
      resolution = "single-eligible-fallback";
    }

    const lockedProjectId = this.resolvedProjects.get(request.id);
    if (lockedProjectId !== undefined && lockedProjectId !== resolvedProjectId) {
      throw new AoProtocolError(
        `Task ${request.id} is already routed to AO project ${lockedProjectId}`,
      );
    }

    this.resolvedProjects.set(request.id, resolvedProjectId);
    if (!this.routingAudit.has(request.id)) {
      const entry: ProjectRoutingAuditEntry = {
        event: "project-routing-resolved",
        taskId: request.id,
        ...(requestedProjectId === undefined ? {} : { requestedProjectId }),
        resolvedProjectId,
        resolution,
      };
      this.routingAudit.set(request.id, entry);
      this.options.auditLogger?.(entry);
    }

    return resolvedProjectId;
  }

  public async getTaskStatus(handle: TaskHandle): Promise<TaskStatus> {
    const conversation = await this.findConversationPage(handle);
    const turn = this.findTurn(conversation, handle);

    switch (turn.state) {
      case "queued":
        return "pending";
      case "running":
      case "completed":
      case "interrupted":
      case "failed":
        return turn.state;
      default:
        throw new AoProtocolError(`Unsupported AO turn state: ${turn.state}`);
    }
  }

  public async getTaskResult(handle: TaskHandle): Promise<TaskResult> {
    const conversation = await this.findConversationPage(handle);
    const turn = this.findTurn(conversation, handle);

    if (turn.state !== "completed") {
      throw new AoProtocolError(`AO turn ${handle.turnId} is not completed`);
    }

    const message = this.getMessages(conversation)
      .filter(
        (candidate) =>
          candidate.turnId === handle.turnId &&
          candidate.role === "assistant" &&
          candidate.streaming === false,
      )
      .sort((left, right) => right.sequence - left.sequence)[0];

    if (!message) {
      throw new TaskResultUnavailableError(
        `No completed assistant message for AO turn ${handle.turnId}`,
      );
    }

    return {
      id: handle.turnId,
      status: "completed",
      output: message.text,
    };
  }

  private async getConversation(
    sessionId: string,
    beforeSequence?: number,
  ): Promise<unknown> {
    const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation`;
    const paginatedPath =
      beforeSequence === undefined
        ? path
        : `${path}?beforeSequence=${encodeURIComponent(String(beforeSequence))}`;

    return this.fetchJson(paginatedPath);
  }

  private async findConversationPage(handle: TaskHandle): Promise<unknown> {
    let beforeSequence: number | undefined;

    while (true) {
      const conversation = await this.getConversation(handle.sessionId, beforeSequence);
      const turns = this.getTurns(conversation);

      if (turns.some((turn) => turn.id === handle.turnId)) {
        return conversation;
      }

      const hasMoreBefore = this.getBoolean(
        conversation,
        "hasMoreBefore",
        "conversation snapshot",
      );
      if (!hasMoreBefore) {
        throw new AoProtocolError(`AO turn ${handle.turnId} was not found`);
      }

      const oldestSequence = this.getNumber(
        conversation,
        "oldestSequence",
        "conversation snapshot",
      );
      if (!Number.isFinite(oldestSequence) || oldestSequence === beforeSequence) {
        throw new AoProtocolError("Invalid AO conversation pagination");
      }

      beforeSequence = oldestSequence;
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
    } catch {
      throw new AoRequestError("Failed to reach Agent Orchestrator.");
    }

    if (!response.ok) {
      throw new AoRequestError(
        `Agent Orchestrator request failed: ${response.status} ${response.statusText}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new AoProtocolError("Agent Orchestrator returned an invalid JSON response.");
    }
  }

  private async verifyCompatibility(): Promise<void> {
    const requiredPaths = [
      "/api/v1/sessions/{sessionId}/conversation",
      "/api/v1/sessions/{sessionId}/conversation/messages",
    ];

    for (const path of requiredPaths) {
      let response: Response;

      try {
        response = await fetch(`${this.options.baseUrl}${path}`, { method: "OPTIONS" });
      } catch {
        throw new AoRequestError("Failed to verify Agent Orchestrator compatibility.");
      }

      if (response.status === 404) {
        throw new UnsupportedAgentOrchestratorVersionError();
      }

      if (response.status >= 500) {
        throw new AoRequestError("Agent Orchestrator compatibility check failed.");
      }
    }
  }

  private getSessionId(response: unknown): string {
    if (!this.isRecord(response) || !this.isRecord(response.session)) {
      throw new AoProtocolError("Invalid AO SpawnSessionResponse");
    }

    return this.getString(response.session, "id", "SpawnSessionResponse.session");
  }

  private findTurn(conversation: unknown, handle: TaskHandle): ConversationTurn {
    const turns = this.getTurns(conversation);
    const turn = turns.find((candidate) => candidate.id === handle.turnId);

    if (!turn) {
      throw new AoProtocolError(`AO turn ${handle.turnId} was not found`);
    }

    return turn;
  }

  private getTurns(conversation: unknown): ConversationTurn[] {
    return this.getArray(conversation, "turns", "conversation snapshot").map(
      (turn) => ({
        id: this.getString(turn, "id", "conversation turn"),
        state: this.getString(turn, "state", "conversation turn"),
      }),
    );
  }

  private getMessages(conversation: unknown): ConversationMessage[] {
    return this.getArray(conversation, "messages", "conversation snapshot").map(
      (message) => ({
        turnId: this.getString(message, "turnId", "conversation message"),
        role: this.getString(message, "role", "conversation message"),
        streaming: this.getBoolean(message, "streaming", "conversation message"),
        sequence: this.getNumber(message, "sequence", "conversation message"),
        text: this.getString(message, "text", "conversation message"),
      }),
    );
  }

  private getArray(value: unknown, key: string, context: string): Record<string, unknown>[] {
    if (!this.isRecord(value) || !Array.isArray(value[key])) {
      throw new AoProtocolError(`Invalid AO ${context}`);
    }

    return value[key].map((entry) => {
      if (!this.isRecord(entry)) {
        throw new AoProtocolError(`Invalid AO ${context}`);
      }

      return entry;
    });
  }

  private getString(value: unknown, key: string, context: string): string {
    if (!this.isRecord(value) || typeof value[key] !== "string") {
      throw new AoProtocolError(`Invalid AO ${context}.${key}`);
    }

    return value[key];
  }

  private getBoolean(value: unknown, key: string, context: string): boolean {
    if (!this.isRecord(value) || typeof value[key] !== "boolean") {
      throw new AoProtocolError(`Invalid AO ${context}.${key}`);
    }

    return value[key];
  }

  private getNumber(value: unknown, key: string, context: string): number {
    if (!this.isRecord(value) || typeof value[key] !== "number") {
      throw new AoProtocolError(`Invalid AO ${context}.${key}`);
    }

    return value[key];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
