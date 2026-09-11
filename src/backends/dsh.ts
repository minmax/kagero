/**
 * dsh backend — wraps the dsh CLI (DeepSeek Harness).
 *
 * Pattern after dsh-cli-mcp. Subprocess-based.
 */
import type { ModelInfo, PromptOptions } from "../agent.js";
import { CliBackendAgent } from "./base.js";

export class DshAgent extends CliBackendAgent {
  public readonly name = "dsh";

  constructor() {
    super({
      binary: "dsh",
      binaryEnvVar: "DSH_MCP_BIN",
      displayName: "dsh",
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
          provider: provider || "deepseek",
          contextWindow: Number(contextWindowStr) || 8192,
          supportsTools: supportsToolsStr === "true",
          supportsVision: supportsVisionStr === "true",
        };
      })
      .filter((m): m is ModelInfo => m !== null);
  }
}
