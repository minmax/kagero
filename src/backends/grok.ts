/**
 * grok backend — wraps the grok CLI.
 */
import type { ModelInfo, PromptOptions } from "../agent.js";
import { CliBackendAgent } from "./base.js";

export class GrokAgent extends CliBackendAgent {
  public readonly name = "grok";

  constructor() {
    super({
      binary: "grok",
      binaryEnvVar: "GROK_MCP_BIN",
      displayName: "grok",
    });
  }

  protected buildArgs(prompt: string, _opts: PromptOptions): string[] {
    return ["--print", prompt];
  }

  protected parseModels(stdout: string): ModelInfo[] {
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        const [id, displayName, provider, contextWindowStr] = line.split("\t");
        if (!id) return null;
        return {
          id,
          displayName: displayName || id,
          provider: provider || "grok",
          contextWindow: Number(contextWindowStr) || 8192,
          supportsTools: true,
          supportsVision: false,
        };
      })
      .filter((m): m is ModelInfo => m !== null);
  }
}
