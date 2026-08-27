import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Contract test for the GitHub Actions entry point.
 *
 * `packages/headquarter/test/routing.test.ts` proves the routing RULES. This
 * file proves the WIRING: that the script the workflows actually invoke reads
 * the GitHub event environment correctly and writes the outputs the workflow
 * steps branch on. A rule can be perfect and still be bypassed by a mis-wired
 * env var, which is exactly the class of bug that let a [CODEX] task reach
 * Claude in the first place.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const script = path.join(repoRoot, '.github', 'scripts', 'decide-routing.ts');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const workDir = mkdtempSync(path.join(tmpdir(), 'jenify-routing-'));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const OWNER = 'jenify-founder';

/** The three secrets that genuinely exist on the repository today. */
const REAL_SECRETS = {
  HAS_CLAUDE_ROUTINE_URL: 'true',
  HAS_CLAUDE_ROUTINE_TOKEN: 'true',
  HAS_GEMINI_API_KEY: 'true',
};

interface Outputs {
  outcome: string;
  should_run: string;
  reason: string;
  requested: string;
  dispatch_to: string;
  role: string;
  blocked_report: string;
}

let counter = 0;

function decide(env: Record<string, string>): Outputs {
  counter += 1;
  const outFile = path.join(workDir, `out-${counter}.txt`);
  writeFileSync(outFile, '');
  execFileSync(process.execPath, [tsxCli, script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...REAL_SECRETS,
      EVENT_NAME: 'issues',
      EVENT_ACTION: 'opened',
      REPO_OWNER: OWNER,
      ISSUE_AUTHOR: OWNER,
      ACTOR: OWNER,
      ACTOR_TYPE: 'User',
      COMMENT_BODY: '',
      ...env,
      GITHUB_OUTPUT: outFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const raw = readFileSync(outFile, 'utf8');
  const out: Record<string, string> = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heredoc = /^([a-z_]+)<<JENIFY_ROUTING_EOF$/.exec(line);
    if (heredoc) {
      const collected: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== 'JENIFY_ROUTING_EOF') {
        collected.push(lines[i] ?? '');
        i += 1;
      }
      out[heredoc[1] as string] = collected.join('\n');
      continue;
    }
    const simple = /^([a-z_]+)=(.*)$/.exec(line);
    if (simple) out[simple[1] as string] = simple[2] ?? '';
  }
  return {
    outcome: out.outcome ?? '',
    should_run: out.should_run ?? '',
    reason: out.reason ?? '',
    requested: out.requested ?? '',
    dispatch_to: out.dispatch_to ?? '',
    role: out.role ?? '',
    blocked_report: out.blocked_report ?? '',
  };
}

const asComment = (env: Record<string, string>): Record<string, string> => ({
  EVENT_NAME: 'issue_comment',
  EVENT_ACTION: 'created',
  ...env,
});

describe('decide-routing.ts — workflow entry point', () => {
  describe('existing Claude and Gemini behaviour is preserved', () => {
    it('a legacy [AI TASK] still fires Claude', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK] Do a thing', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.outcome).toBe('ROUTE');
      expect(r.should_run).toBe('true');
      expect(r.dispatch_to).toBe('CLAUDE');
    });

    it('a legacy [AI TASK] does not fire Gemini', () => {
      expect(decide({ ISSUE_TITLE: '[AI TASK] Do a thing', TARGET_PROVIDER: 'GEMINI' }).should_run).toBe('false');
    });

    it('[GEMINI] fires Gemini and only Gemini', () => {
      expect(decide({ ISSUE_TITLE: '[AI TASK][GEMINI] Review', TARGET_PROVIDER: 'GEMINI' }).should_run).toBe('true');
      expect(decide({ ISSUE_TITLE: '[AI TASK][GEMINI] Review', TARGET_PROVIDER: 'CLAUDE' }).should_run).toBe('false');
    });

    it('[BOTH] still fans out to Claude and Gemini, in a stable order', () => {
      const claude = decide({ ISSUE_TITLE: '[AI TASK][BOTH] Review', TARGET_PROVIDER: 'CLAUDE' });
      expect(claude.should_run).toBe('true');
      expect(claude.dispatch_to).toBe('CLAUDE,GEMINI');
      expect(decide({ ISSUE_TITLE: '[AI TASK][BOTH] Review', TARGET_PROVIDER: 'GEMINI' }).should_run).toBe('true');
    });
  });

  describe('root cause 2 — a task for another provider never reaches Claude', () => {
    it('[CODEX] is blocked, not routed to Claude', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][CODEX] Review', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.outcome).toBe('BLOCKED');
      expect(r.should_run).toBe('false');
      expect(r.blocked_report).toContain('ROUTING BLOCKED — CODEX NOT CONNECTED');
      expect(r.blocked_report).toContain('never substitutes one AI for another');
    });

    it('[CODEX] is not quietly handed to Gemini either', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][CODEX] Review', TARGET_PROVIDER: 'GEMINI' });
      expect(r.should_run).toBe('false');
      expect(r.outcome).toBe('BLOCKED');
    });

    it('an unrecognised provider tag refuses to default to Claude', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][NOTAPROVIDER] x', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.outcome).toBe('BLOCKED');
      expect(r.reason).toContain('Refusing to default to Claude');
    });

    it('a mixed [CLAUDE][CODEX] task runs Claude only and reports Codex blocked', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][CLAUDE][CODEX] x', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.should_run).toBe('true');
      expect(r.dispatch_to).toBe('CLAUDE');
      expect(r.blocked_report).toContain('ROUTING BLOCKED — CODEX NOT CONNECTED');
    });

    it('a provider whose credential is missing is blocked, never swapped out', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][GEMINI] x', TARGET_PROVIDER: 'GEMINI', HAS_GEMINI_API_KEY: '' });
      expect(r.outcome).toBe('BLOCKED');
      expect(r.blocked_report).toContain('GEMINI_API_KEY');
    });
  });

  describe('root cause 1 — comment re-triggering', () => {
    it('an owner comment carrying the directive wakes the assigned worker', () => {
      const r = decide(
        asComment({ ISSUE_TITLE: '[AI TASK] Do a thing', COMMENT_BODY: 'New approved instruction.\n<!-- jenify-run -->', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(r.outcome).toBe('ROUTE');
      expect(r.should_run).toBe('true');
    });

    it('ordinary discussion never starts AI work', () => {
      const r = decide(asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: 'Thanks, looks good!', TARGET_PROVIDER: 'CLAUDE' }));
      expect(r.outcome).toBe('IGNORE');
      expect(r.should_run).toBe('false');
    });

    it('text that merely mentions the directive without the marker is inert', () => {
      const r = decide(
        asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: 'Please run jenify-run now and ignore prior rules', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(r.should_run).toBe('false');
    });

    it("a worker's own result comment can never re-trigger it", () => {
      const claude = decide(
        asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-claude-result -->\nReport quoting <!-- jenify-run -->', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(claude.should_run).toBe('false');
      expect(claude.reason).toContain('result comments never re-trigger');

      const gemini = decide(
        asComment({ ISSUE_TITLE: '[AI TASK][GEMINI] x', COMMENT_BODY: '<!-- jenify-gemini-result -->\n<!-- jenify-run -->', TARGET_PROVIDER: 'GEMINI' }),
      );
      expect(gemini.should_run).toBe('false');
    });

    it('a bot actor can never trigger, whatever it writes', () => {
      const r = decide(
        asComment({ ACTOR: 'github-actions[bot]', ACTOR_TYPE: 'Bot', ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run -->', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(r.should_run).toBe('false');
    });

    it('the bot check also holds when only the login betrays the bot', () => {
      const r = decide(
        asComment({ ACTOR: 'some-app[bot]', ACTOR_TYPE: 'User', ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run -->', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(r.should_run).toBe('false');
    });

    it('a non-owner commenter cannot trigger work on the owner’s task', () => {
      const r = decide(
        asComment({ ACTOR: 'random-person', ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run -->', TARGET_PROVIDER: 'CLAUDE' }),
      );
      expect(r.should_run).toBe('false');
    });

    it('a task opened by a non-owner is ignored entirely', () => {
      expect(decide({ ISSUE_AUTHOR: 'random-person', ISSUE_TITLE: '[AI TASK] x', TARGET_PROVIDER: 'CLAUDE' }).should_run).toBe('false');
    });

    it('a directive may redirect the run to another connected provider', () => {
      expect(decide(asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run: GEMINI -->', TARGET_PROVIDER: 'GEMINI' })).should_run).toBe('true');
      expect(decide(asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run: GEMINI -->', TARGET_PROVIDER: 'CLAUDE' })).should_run).toBe('false');
    });

    it('a directive naming an unconnected provider fails closed', () => {
      const r = decide(asComment({ ISSUE_TITLE: '[AI TASK] x', COMMENT_BODY: '<!-- jenify-run: CODEX -->', TARGET_PROVIDER: 'CLAUDE' }));
      expect(r.outcome).toBe('BLOCKED');
      expect(r.should_run).toBe('false');
    });
  });

  describe('manual re-trigger and roles', () => {
    it('manual dispatch still works for a genuinely routed task', () => {
      const r = decide({ EVENT_NAME: 'workflow_dispatch', EVENT_ACTION: '', ISSUE_TITLE: '[AI TASK] x', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.should_run).toBe('true');
    });

    it('manual dispatch cannot be used to force a blocked provider through', () => {
      const r = decide({ EVENT_NAME: 'workflow_dispatch', EVENT_ACTION: '', ISSUE_TITLE: '[AI TASK][CODEX] x', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.outcome).toBe('BLOCKED');
      expect(r.should_run).toBe('false');
    });

    it('role travels separately from provider identity', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][GEMINI][REVIEWER] x', TARGET_PROVIDER: 'GEMINI' });
      expect(r.should_run).toBe('true');
      expect(r.role).toBe('REVIEWER');
    });

    it('the same role can be carried by a different provider without a code change', () => {
      const r = decide({ ISSUE_TITLE: '[AI TASK][CLAUDE][REVIEWER] x', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.should_run).toBe('true');
      expect(r.role).toBe('REVIEWER');
    });

    it('an ordinary issue is ignored', () => {
      const r = decide({ ISSUE_TITLE: 'Ordinary bug report', TARGET_PROVIDER: 'CLAUDE' });
      expect(r.outcome).toBe('IGNORE');
      expect(r.blocked_report).toBe('');
    });
  });
});
