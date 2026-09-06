/**
 * Workforce configuration CLI — a TRUSTED-LOCAL-ADMIN / MAINTENANCE
 * interface (Phase 4, issue #262; the `hq:order` trust model, verbatim).
 *
 * Everything here is CONFIGURATION: registering the Phase 3/4 Founder-gated
 * capabilities, bootstrapping a human principal, registering/disabling AI
 * members, declaring member health, and deactivating an execution worker.
 * Nothing here places an order, creates a task, or executes anything.
 *
 * The trust model is `live/local-trust.ts`, unchanged: `--as <id>` asserts a
 * principal id and binds it to nothing; the interface establishes only that
 * the caller can run a process against the HQ SQLite file — someone who
 * could already write that file directly. `--local-admin` is the required
 * acknowledgement, and the command refuses to run under CI entirely.
 *
 * PRINCIPAL BOOTSTRAP, stated plainly: `--register-principal` writes to the
 * human-principal registry through its own register() — there is no facade
 * method, deliberately, because the very first principal cannot be gated on
 * a principal existing. This is the one action here that cannot demand an
 * existing `--as` authority; every other actor-attributed action goes
 * through the ordinary Founder-gated facade methods and is refused for a
 * caller whose asserted principal lacks the authority.
 *
 * register() is an UPSERT, and this command inherits that: re-running it
 * against an EXISTING id REPLACES all four fields from the flags given on
 * THIS invocation — omitting `--grants` wipes the grants to [], omitting
 * `--approval-authority` drops approval authority to false, and `active` is
 * always written true (so it reactivates a deactivated principal). No merge
 * with the previous row happens, and no evidence row is written (the
 * local-trust model, same as above). The command detects the pre-existing
 * row and says "replaced" instead of "registered" so the overwrite is never
 * silent.
 *
 * ## Usage
 *
 *   hq:workforce --local-admin --register-capability <id> [--db <path>]
 *       Registers one of the known Founder-gated capabilities if absent:
 *       hq.mission_command | hq.project_command | hq.workforce_assign.
 *       Never enables a capability someone disabled.
 *
 *   hq:workforce --local-admin --register-principal <id>
 *       [--display-name "<name>"] [--grants <cap>[,<cap>…]]
 *       [--approval-authority] [--db <path>]
 *       UPSERT: an existing id is REPLACED wholesale from this invocation's
 *       flags (omitted flags become the defaults, active is forced true).
 *
 *   hq:workforce --local-admin --register-member <id> --as <principalId>
 *       --member-provider <vendorId> --member-model <modelId> --member-version <v>
 *       [--member-type interactive|execution|review|automation]
 *       [--member-locality local|cloud] [--member-privacy open|internal|confidential|restricted]
 *       [--member-cost free|low|medium|high|premium] [--member-grants <cap>[,<cap>…]]
 *       [--db <path>]
 *
 *   hq:workforce --local-admin --disable-member <id> --as <principalId>
 *       --reason "<why>" [--db <path>]
 *
 *   hq:workforce --local-admin --set-member-health <id>=<health> --as <principalId>
 *       [--db <path>]        (health: unknown|healthy|degraded|unavailable)
 *
 *   hq:workforce --local-admin --deactivate-worker <id> --as <principalId>
 *       --reason "<why>" [--db <path>]
 *
 * Local only: no network call is made by this file.
 */

import { openHqDatabase, type HqDatabase } from '../store/db.js';
import { HeadquarterOperations } from '../application/service.js';
import { HumanPrincipalRegistry } from '../application/principals.js';
import {
  MISSION_COMMAND_CAPABILITY,
  missionCommandCapabilityState,
  registerMissionCommandCapability,
} from '../application/mission-command.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  projectCommandCapabilityState,
  registerProjectCommandCapability,
} from '../application/project-command.js';
import {
  WORKFORCE_ASSIGN_CAPABILITY,
  registerWorkforceAssignCapability,
  workforceAssignCapabilityState,
} from '../application/workforce-command.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  memoryCommandCapabilityState,
  registerMemoryCommandCapability,
} from '../application/memory-command.js';
import { AiMemberRegistry } from '../registry/members.js';
import { MemberCapabilityRegistry } from '../registry/capabilities.js';
import { ProviderDirectory } from '../providers/directory.js';
import { declaredOnlyAdapter } from '../providers/declared.js';
import { KNOWN_PROVIDERS } from '../providers/known.js';
import type { Capability } from '../operator/capabilities.js';
import {
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  resolveLocalAdminInvocation,
} from '../live/local-trust.js';
import { readFlag, missingFlagValueMessage } from './flags.js';

/**
 * The capabilities this command may register — fail closed: an id outside
 * this list is refused, never guessed into a registration.
 */
const REGISTRABLE = {
  [MISSION_COMMAND_CAPABILITY.id]: {
    register: registerMissionCommandCapability,
    state: missionCommandCapabilityState,
  },
  [PROJECT_COMMAND_CAPABILITY.id]: {
    register: registerProjectCommandCapability,
    state: projectCommandCapabilityState,
  },
  [WORKFORCE_ASSIGN_CAPABILITY.id]: {
    register: registerWorkforceAssignCapability,
    state: workforceAssignCapabilityState,
  },
  // Phase 5 (issue #265): the memory-command trio joins the fail-closed list.
  [MEMORY_COMMAND_CAPABILITY.id]: {
    register: registerMemoryCommandCapability,
    state: memoryCommandCapabilityState,
  },
} as const;

export interface WorkforceCliResult {
  ok: boolean;
  lines: string[];
}

function fail(lines: string[], message: string): WorkforceCliResult {
  return { ok: false, lines: [...lines, message] };
}

/**
 * The command's whole behavior, exported so tests execute the rule rather
 * than assert about a file that calls main() at import time. `openDb` is
 * injected so tests run in memory; the flag/refusal semantics are identical.
 */
export function executeWorkforceCommand(
  argv: string[],
  openDb: (path?: string) => HqDatabase,
): WorkforceCliResult {
  const lines: string[] = [];
  const flag = (name: string): string | null => {
    const reading = readFlag(argv, name);
    if (reading.kind === 'missing_value') {
      throw new Error(missingFlagValueMessage(name));
    }
    return reading.kind === 'value' ? reading.value : null;
  };

  const dbPath = flag('db') ?? undefined;
  const asPrincipal = flag('as');
  const registerCapability = flag('register-capability');
  const registerPrincipal = flag('register-principal');
  const registerMember = flag('register-member');
  const disableMember = flag('disable-member');
  const setHealth = flag('set-member-health');
  const deactivateWorker = flag('deactivate-worker');

  const actions = [
    registerCapability,
    registerPrincipal,
    registerMember,
    disableMember,
    setHealth,
    deactivateWorker,
  ].filter((value) => value != null);
  if (actions.length !== 1) {
    return fail(
      lines,
      'Exactly one configuration action per run: --register-capability, --register-principal, ' +
        '--register-member, --disable-member, --set-member-health or --deactivate-worker.',
    );
  }

  if (registerCapability) {
    const entry = REGISTRABLE[registerCapability as keyof typeof REGISTRABLE];
    if (!entry) {
      return fail(
        lines,
        `Unknown capability: ${registerCapability}. This command registers exactly ` +
          `${Object.keys(REGISTRABLE).join(', ')} — nothing else, and never by guessing.`,
      );
    }
    const db = openDb(dbPath);
    const row = (id: string): Capability | null => {
      const raw = db.prepare(`SELECT * FROM op_capabilities WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      if (!raw) return null;
      return {
        id: raw.id as string,
        description: raw.description as string,
        riskClass: raw.risk_class as Capability['riskClass'],
        sideEffect: !!raw.side_effect,
        idempotent: !!raw.idempotent,
        enabled: !!raw.enabled,
      };
    };
    const before = entry.state(row(registerCapability));
    entry.register(db);
    const after = entry.state(row(registerCapability));
    lines.push(`Capability ${registerCapability}: ${before} → ${after}`);
    if (after === 'disabled') {
      lines.push(
        'It stays DISABLED. Registration does not enable a capability that was deliberately ' +
          'disabled; re-enabling it is its own explicit configuration decision.',
      );
    }
    lines.push('Configuration only — nothing was executed.');
    return { ok: true, lines };
  }

  if (registerPrincipal) {
    const db = openDb(dbPath);
    const registry = new HumanPrincipalRegistry(db);
    const grants = (flag('grants') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const displayName = flag('display-name') ?? registerPrincipal;
    const approvalAuthority = argv.includes('--approval-authority');
    // register() is an UPSERT: read first so the output can say what
    // actually happened — a wholesale replace is never reported as a fresh
    // registration.
    const existing = registry.get(registerPrincipal);
    registry.register({
      id: registerPrincipal,
      displayName,
      originateCapabilities: grants,
      approvalAuthority,
      active: true,
    });
    lines.push(
      `Principal ${registerPrincipal} ${existing ? 'REPLACED' : 'registered'} (${displayName}): ` +
        `originate=[${grants.join(', ')}], approvalAuthority=${approvalAuthority}.`,
    );
    if (existing) {
      lines.push(
        'UPSERT: the existing row was replaced wholesale from THIS invocation — previous ' +
          `grants [${existing.originateCapabilities.join(', ')}], approvalAuthority=` +
          `${existing.approvalAuthority}, active=${existing.active} no longer apply, and ` +
          'active was written true.',
      );
    }
    lines.push(
      'BOOTSTRAP PATH: this wrote the principal registry directly — the local-trust model, not ' +
        'an authenticated act. The very first principal cannot be gated on a principal existing.',
    );
    lines.push('Configuration only — nothing was executed.');
    return { ok: true, lines };
  }

  // Every remaining action is actor-attributed and goes through the
  // Founder-gated facade — the asserted principal must genuinely hold the
  // authority, or the facade refuses.
  if (!asPrincipal) {
    return fail(lines, 'This action needs --as <principalId>: the acting principal must hold the required authority.');
  }
  const db = openDb(dbPath);
  const providers = new ProviderDirectory();
  for (const descriptor of KNOWN_PROVIDERS) providers.register(declaredOnlyAdapter(descriptor));
  const ops = new HeadquarterOperations(db, {
    aiMemberRegistry: new AiMemberRegistry(db, providers, new MemberCapabilityRegistry(db)),
  });

  if (registerMember) {
    const provider = flag('member-provider');
    const model = flag('member-model');
    const version = flag('member-version');
    if (!provider || !model || !version) {
      return fail(
        lines,
        '--register-member needs --member-provider, --member-model and --member-version: ' +
          'identity is immutable once registered, so it is stated fully or not at all.',
      );
    }
    const grants = (flag('member-grants') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const result = ops.registerAiMember({
      id: registerMember,
      displayName: flag('member-name') ?? registerMember,
      providerId: provider,
      modelId: model,
      modelVersion: version,
      workerType: (flag('member-type') ?? 'execution') as 'execution',
      locality: (flag('member-locality') ?? 'cloud') as 'cloud',
      privacyClass: (flag('member-privacy') ?? 'internal') as 'internal',
      costClass: (flag('member-cost') ?? 'medium') as 'medium',
      grantedCapabilities: grants,
      founderId: asPrincipal,
    });
    if (!result.ok) {
      return fail(lines, `Registration refused (${result.error.code}): ${result.error.message}`);
    }
    lines.push(
      `Member ${result.data.member.id} registered: ${result.data.member.identityKey}, health ` +
        `${result.data.member.health} (nothing probed, nothing claimed).`,
    );
    if (result.data.enrichesExecutionWorker) {
      lines.push('It shares its id with a registered execution worker — enrichment, not enrolment.');
    } else {
      lines.push('No execution worker holds this id: the member is registry-only and can execute nothing.');
    }
    for (const warning of result.data.warnings) lines.push(`Warning: ${warning}`);
    lines.push('Configuration only — nothing was executed.');
    return { ok: true, lines };
  }

  if (disableMember) {
    const reason = flag('reason');
    if (!reason) return fail(lines, '--disable-member needs --reason "<why>".');
    const result = ops.disableAiMember({ memberId: disableMember, reason, founderId: asPrincipal });
    if (!result.ok) {
      return fail(lines, `Disable refused (${result.error.code}): ${result.error.message}`);
    }
    lines.push(`Member ${disableMember} disabled.`);
    if (result.data.handoverRequired.length > 0) {
      lines.push(
        `HANDOVER REQUIRED for ${result.data.handoverRequired.length} active assignment(s): ` +
          result.data.handoverRequired.map((assignment) => assignment.id).join(', '),
      );
    }
    lines.push('Configuration only — nothing was executed.');
    return { ok: true, lines };
  }

  if (setHealth) {
    const [memberId, health] = setHealth.split('=');
    if (!memberId || !health) {
      return fail(lines, '--set-member-health expects <memberId>=<health>, e.g. fable-main=healthy.');
    }
    const result = ops.setAiMemberHealth({ memberId, health, founderId: asPrincipal });
    if (!result.ok) {
      return fail(lines, `Health declaration refused (${result.error.code}): ${result.error.message}`);
    }
    lines.push(
      `Member ${memberId} health declared ${result.data.health} at ${result.data.healthCheckedAt} — ` +
        'an explicit statement by the acting principal, never a probe.',
    );
    lines.push('Configuration only — nothing was executed.');
    return { ok: true, lines };
  }

  const reason = flag('reason');
  if (!reason) return fail(lines, '--deactivate-worker needs --reason "<why>".');
  const result = ops.deactivateExecutionWorker({
    workerId: deactivateWorker!,
    reason,
    founderId: asPrincipal,
  });
  if (!result.ok) {
    return fail(lines, `Deactivation refused (${result.error.code}): ${result.error.message}`);
  }
  lines.push(
    `Worker ${result.data.id} deactivated. There is deliberately no reactivate action here: ` +
      'turning a worker back on is a widening and stays a separate recorded decision.',
  );
  lines.push('Configuration only — nothing was executed.');
  return { ok: true, lines };
}

function main(): void {
  const argv = process.argv.slice(2);
  const invocation = resolveLocalAdminInvocation(argv, process.env);
  if (!invocation.ok) {
    console.error(invocation.message);
    process.exit(2);
  }
  console.log(`${LOCAL_ADMIN_INTERFACE_NOTICE}\n`);
  let result: WorkforceCliResult;
  try {
    result = executeWorkforceCommand(argv, (path) => openHqDatabase(path));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\nRun with ${LOCAL_ADMIN_ACK_FLAG} and exactly one action; see the file header for usage.`);
    process.exit(2);
  }
  for (const line of result.lines) console.log(line);
  if (!result.ok) process.exit(1);
}

// The direct-order pattern: import-time main, guarded so tests can import the
// exported command without running it.
if (process.argv[1] != null && /workforce\.(ts|js)$/.test(process.argv[1])) {
  main();
}
