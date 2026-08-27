/**
 * Codex connectivity probe.
 *
 * Produces the NON-SECRET facts routing needs to decide whether CODEX is
 * genuinely executable on this machine:
 *
 *   CODEX_CLI_PATH   absolute path of the Codex CLI binary
 *   CODEX_AUTH_MODE  the auth mode name recorded by the CLI ('chatgpt' | 'apikey')
 *
 * What this module deliberately does NOT do: read, log, or return any token.
 * `auth.json` is opened only to learn WHICH auth mode is configured and
 * WHETHER credentials exist. The values never leave this function.
 *
 * Nothing here decides policy — providers.ts does. This only observes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CodexProbeResult {
  installed: boolean;
  cliPath: string | null;
  /** 'chatgpt' (subscription session) | 'apikey' | null when unknown. */
  authMode: string | null;
  /** True when auth.json holds a usable credential of some kind. */
  authenticated: boolean;
  codexHome: string | null;
  /**
   * Directories holding the CLI's bundled helper executables (ripgrep, the
   * command runner). Codex shells out to these; if they are not on PATH the
   * agent cannot search the repo and the review fails.
   */
  helperPaths: string[];
  /** Non-secret facts to merge into the routing environment. */
  facts: Record<string, string>;
  /** Human-readable explanation, safe to print. */
  reason: string;
}

/** Default Codex CLI install root on Windows. */
function defaultInstallRoots(): string[] {
  const home = homedir();
  return [
    join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.codex', 'bin'),
  ];
}

function findCodexBinary(explicit?: string | null): string | null {
  if (explicit != null && explicit.trim() !== '' && existsSync(explicit)) return explicit;

  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const root of defaultInstallRoots()) {
    if (!existsSync(root)) continue;
    // The installer keeps versioned subdirectories; take the newest that holds
    // a codex binary so an upgrade does not silently break the lane.
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const name of names) {
      const direct = join(root, name);
      if (existsSync(direct)) candidates.push({ path: direct, mtime: safeMtime(direct) });
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      for (const name of names) {
        const p = join(dir, name);
        if (existsSync(p)) candidates.push({ path: p, mtime: safeMtime(p) });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      return candidates[0]!.path;
    }
  }
  return null;
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read ONLY the auth mode from auth.json. Token values are never returned,
 * logged, or retained.
 */
function readAuthMode(codexHome: string): { authMode: string | null; authenticated: boolean } {
  const authFile = join(codexHome, 'auth.json');
  if (!existsSync(authFile)) return { authMode: null, authenticated: false };
  try {
    const parsed = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    const authMode = typeof parsed['auth_mode'] === 'string' ? (parsed['auth_mode'] as string) : null;
    const tokens = parsed['tokens'];
    const hasSession =
      tokens != null && typeof tokens === 'object' && typeof (tokens as Record<string, unknown>)['access_token'] === 'string';
    const hasApiKey = typeof parsed['OPENAI_API_KEY'] === 'string' && (parsed['OPENAI_API_KEY'] as string).trim() !== '';
    return { authMode: authMode ?? (hasApiKey ? 'apikey' : null), authenticated: hasSession || hasApiKey };
  } catch {
    return { authMode: null, authenticated: false };
  }
}

export interface ProbeOptions {
  /** Override the CLI path (CODEX_CLI_PATH env, or an explicit setting). */
  cliPath?: string | null;
  /** Override CODEX_HOME. */
  codexHome?: string | null;
}

/**
 * The Codex installer keeps its helper binaries in sibling versioned folders
 * next to codex.exe. The desktop app puts them on PATH for itself; a headless
 * spawn must do the same or the agent's own tooling is missing.
 */
function findHelperPaths(cliPath: string | null): string[] {
  if (cliPath == null) return [];
  const ownDir = dirname(cliPath);
  const binRoot = dirname(ownDir);
  const out = new Set<string>([ownDir]);
  try {
    for (const entry of readdirSync(binRoot)) {
      const dir = join(binRoot, entry);
      try {
        if (statSync(dir).isDirectory()) out.add(dir);
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    /* binRoot unreadable; the CLI's own directory is still useful */
  }
  return [...out];
}

export function probeCodex(options: ProbeOptions = {}): CodexProbeResult {
  const codexHome = options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
  const cliPath = findCodexBinary(options.cliPath ?? process.env['CODEX_CLI_PATH'] ?? null);
  const installed = cliPath != null;
  const { authMode, authenticated } = existsSync(codexHome)
    ? readAuthMode(codexHome)
    : { authMode: null, authenticated: false };

  const facts: Record<string, string> = {};
  if (cliPath != null) facts['CODEX_CLI_PATH'] = cliPath;
  if (authenticated && authMode != null) facts['CODEX_AUTH_MODE'] = authMode;

  let reason: string;
  if (!installed) {
    reason = 'Codex CLI not found. Install the Codex app/CLI, or set CODEX_CLI_PATH to its binary.';
  } else if (!authenticated) {
    reason = `Codex CLI found at ${cliPath}, but no credential is present in ${codexHome}. Run 'codex login' once.`;
  } else {
    reason = `Codex CLI ${cliPath} is installed and authenticated (auth mode: ${authMode}).`;
  }

  return { installed, cliPath, authMode, authenticated, codexHome, helperPaths: findHelperPaths(cliPath), facts, reason };
}
