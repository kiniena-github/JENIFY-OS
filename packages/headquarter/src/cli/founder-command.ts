/**
 * `hq:founder-command` — configuration and read-only inspection for the Phase 3
 * Founder Command capability (issue #253).
 *
 * Two commands wearing one name, never performed in the same run:
 *
 *   --register-capability   registers `hq.founder_command` if absent. Like
 *                           `hq:order --register-capability`, it never
 *                           re-enables a capability that was disabled and it
 *                           issues no command.
 *   --list                  prints the STORED mission columns from a READ-ONLY
 *                           connection — never the original command, and never
 *                           the derived status, which needs the service's
 *                           canonical task read and so cannot be produced over
 *                           a read-only connection (see the comment at the
 *                           call site). No schema is created or migrated; a
 *                           missing database is an error, not a new empty one
 *                           (`openHqDatabaseReadOnly`).
 *
 * Deliberately NO `--instruction` here. Issuing a Founder Command is the
 * authenticated browser path (`POST /api/hq/control/missions`) or an
 * in-process call by a composition root that has resolved the principal; a
 * CLI that asserted `--as founder` would be one more trusted-local-admin
 * interface authenticating nobody, and the mission's `actorAuthentication`
 * would have to say so. The existing `hq:order` already carries that trade-off
 * for direct orders; Phase 3 does not add a second one.
 */

import { openHqDatabase, openHqDatabaseReadOnly } from '../store/db.js';
import { HeadquarterOperations } from '../application/service.js';
import {
  FOUNDER_COMMAND_CAPABILITY,
  registerFounderCommandCapability,
} from '../application/mission-core.js';
import { readFlag, missingFlagValueMessage } from './flags.js';

function usage(message: string): never {
  console.error(`${message}

Usage:
  hq:founder-command --register-capability [--db <path>]
      Configuration only: registers ${FOUNDER_COMMAND_CAPABILITY.id} if it is absent.
      Never enables a capability that was disabled; issues no command.

  hq:founder-command --list [--db <path>]
      Read-only: prints every recorded mission's browser-safe view.
`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | null {
  const reading = readFlag(argv, name);
  if (reading.kind === 'missing_value') usage(missingFlagValueMessage(name));
  return reading.kind === 'value' ? reading.value : null;
}

function main(argv: string[]): void {
  const dbPath = flag(argv, 'db') ?? undefined;
  const register = argv.includes('--register-capability');
  const list = argv.includes('--list');
  if (register && list) usage('--register-capability and --list are separate commands; run one at a time.');
  if (!register && !list) usage('Choose --register-capability or --list.');

  if (register) {
    const db = openHqDatabase(dbPath);
    const ops = new HeadquarterOperations(db);
    const before = ops.missions.capabilityState();
    registerFounderCommandCapability(db);
    const after = ops.missions.capabilityState();
    console.log(`Capability ${FOUNDER_COMMAND_CAPABILITY.id}: ${before} → ${after}`);
    if (before === 'altered') {
      console.log('Its definition had drifted from the reserved contract and has been restored. Worth asking what re-registered it.');
    }
    if (after === 'disabled') {
      console.log('It stays DISABLED. Registration does not enable a capability that was deliberately disabled.');
    }
    console.log('\nConfiguration only — no Founder command was issued.');
    db.close();
    return;
  }

  const db = openHqDatabaseReadOnly(dbPath);
  try {
    const rows = db.prepare(`SELECT id FROM hq_missions ORDER BY created_at DESC`).all() as { id: string }[];
    // Plain rows, not the derived view. `HeadquarterOperations` migrates in its
    // constructor, so it cannot be built over a read-only connection, and the
    // derived status needs the service's canonical task read. This command
    // therefore prints exactly what the table holds and says which column is
    // which, rather than deriving a status by a second, unshared rule.
    console.log(`${rows.length} mission(s) recorded in ${dbPath ?? 'data/headquarter.sqlite'}.`);
    for (const row of rows) {
      const mission = db
        .prepare(`SELECT id, title, lifecycle, intent_version, priority, risk_ceiling, created_by, created_at FROM hq_missions WHERE id = ?`)
        .get(row.id) as Record<string, unknown>;
      console.log(
        `- ${mission.id} · ${mission.title} · lifecycle ${mission.lifecycle} · intent v${mission.intent_version} · ` +
          `${mission.priority} · ceiling ${mission.risk_ceiling} · by ${mission.created_by} at ${mission.created_at}`,
      );
    }
    console.log('\nLifecycle is the stored explicit decision; the DERIVED status is what the Founder console shows.');
  } finally {
    db.close();
  }
}

main(process.argv.slice(2));
