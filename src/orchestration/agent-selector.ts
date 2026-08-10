import type { AgentProfile, AgentSelector, OrchestrationRequest } from "./contracts";

export class CapabilityAgentSelector implements AgentSelector {
  public constructor(private readonly profiles: readonly AgentProfile[]) {}

  public select(request: OrchestrationRequest): AgentProfile {
    const profile = this.profiles.find((candidate) =>
      request.requiredCapabilities.every((capability) =>
        candidate.capabilities.capabilities.includes(capability),
      ),
    );

    if (!profile) {
      throw new Error("No agent profile satisfies the required capabilities");
    }

    return profile;
  }
}
