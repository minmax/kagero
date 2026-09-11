/**
 * mcode backend — wraps the mcode CLI.
 */
import type { ModelInfo, PromptOptions } from "../agent.js";
import { CliBackendAgent } from "./base.js";

export class McodeAgent extends CliBackendAgent {
  public readonly name = "mcode";

  constructor() {
    super({
      binary: "mcode",
      binaryEnvVar: "MCODE_MCP_BIN",
      displayName: "mcode",
    });
  }

  protected buildArgs(prompt: string, _opts: PromptOptions): string[] {
    return ["--print", prompt];
  }

  protected parseModels(stdout: string): ModelInfo[] {
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines
      .map((line) => {
        const [id, displayName, provider, contextWindowStr, supportsToolsStr, supportsVisionStr] =
          line.split("\t");
        if (!id) return null;
        return {
          id,
          displayName: displayName || id,
          provider: provider || "mcode",
          contextWindow: Number(contextWindowStr) || 8192,
          supportsTools: supportsToolsStr === "true",
          supportsVision: supportsVisionStr === "true",
        };
      })
      .filter((m): m is ModelInfo => m !== null);
  }
}
