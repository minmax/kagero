// Unit tests for resolveWorkspace — cwd inheritance, mkdir -p, scratch dirs.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspace } from "@kagero/core";

const scratchDirs: string[] = [];

const makeScratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kagero-ws-test-"));
  scratchDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkspace — undefined option", () => {
  it("uses fallbackCwd and never creates anything", async () => {
    const dir = await makeScratchDir();
    const info = await resolveWorkspace(undefined, dir);
    expect(info.cwd).toBe(dir);
    expect(info.path).toBe(dir);
    expect(info.created).toBe(false);
  });

  it("falls back to process.cwd() when no fallback given", async () => {
    const info = await resolveWorkspace(undefined);
    expect(info.cwd).toBe(process.cwd());
    expect(info.created).toBe(false);
  });
});

describe("resolveWorkspace — explicit path", () => {
  it("mkdir -p a missing directory, created: true", async () => {
    const parent = await makeScratchDir();
    const target = path.join(parent, "nested", "run-dir");
    const info = await resolveWorkspace({ path: target });
    expect(info.cwd).toBe(target);
    expect(info.path).toBe(target);
    expect(info.created).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("reports created: false for an existing directory", async () => {
    const dir = await makeScratchDir();
    const info = await resolveWorkspace({ path: dir });
    expect(info.cwd).toBe(dir);
    expect(info.created).toBe(false);
  });
});

describe("resolveWorkspace — fresh scratch dir", () => {
  it("{create: true} creates a unique kagero-ws- directory under os.tmpdir()", async () => {
    const info = await resolveWorkspace({ create: true });
    scratchDirs.push(info.path);
    expect(info.created).toBe(true);
    expect(path.dirname(info.path)).toBe(os.tmpdir());
    expect(path.basename(info.path).startsWith("kagero-ws-")).toBe(true);
    expect(existsSync(info.path)).toBe(true);
  });

  it("{create: true, parent} creates the scratch dir under the given parent", async () => {
    const parent = await makeScratchDir();
    const info = await resolveWorkspace({ create: true, parent });
    scratchDirs.push(info.path);
    expect(info.created).toBe(true);
    expect(path.dirname(info.path)).toBe(parent);
    expect(path.basename(info.path).startsWith("kagero-ws-")).toBe(true);
  });
});
