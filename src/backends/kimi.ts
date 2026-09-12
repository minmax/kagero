/**
 * kimi backend — wraps the kimi-code CLI.
 */
import type { ModelInfo, PromptOptions } from "@kagero/core";
import { CliBackendAgent } from "./base.js";

export class KimiAgent extends CliBackendAgent {
  public readonly name = "kimi";

  constructor() {
    super({
      binary: "kimi",
      binaryEnvVar: "KIMI_MCP_BIN",
      displayName: "kimi",
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
          provider: provider || "kimi",
          contextWindow: Number(contextWindowStr) || 8192,
          supportsTools: supportsToolsStr === "true",
          supportsVision: supportsVisionStr === "true",
        };
      })
      .filter((m): m is ModelInfo => m !== null);
  }
}
