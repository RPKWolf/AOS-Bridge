export class BridgeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedAgentOrchestratorVersionError extends BridgeError {
  public constructor() {
    super(
      "This Agent Orchestrator version does not expose the required public Chat REST API.",
    );
  }
}

export class AoProtocolError extends BridgeError {}

export class AoRequestError extends BridgeError {}

export class TaskNotCompletedError extends BridgeError {}

export class TaskResultUnavailableError extends BridgeError {}

export class TaskUnavailableError extends BridgeError {}

export class InvalidRequestError extends BridgeError {}

export class InvalidConfigurationError extends BridgeError {}

export class AgentOrchestratorTimeoutError extends BridgeError {}

export class AgentTaskFailedError extends BridgeError {}
