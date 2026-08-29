/**
 * Founder-approved JENIFY HQ capability catalog.
 *
 * IMPORTANT: this is policy/configuration, NOT evidence that a tool is
 * installed, authenticated, connected, licensed, or currently available.
 * Runtime truth belongs to the Connection Center/provider evidence layer.
 * This catalog may narrow routing; it never widens Operator authority.
 */

export const HQ_CAPABILITY_KINDS = [
  'agent', 'skill', 'mcp', 'reference', 'library', 'platform', 'model', 'workflow',
] as const;
export type HqCapabilityKind = (typeof HQ_CAPABILITY_KINDS)[number];

export const HQ_CAPABILITY_PRIORITIES = ['core', 'strong', 'later', 'reference_only'] as const;
export type HqCapabilityPriority = (typeof HQ_CAPABILITY_PRIORITIES)[number];

export const HQ_CAPABILITY_COSTS = [
  'free', 'free_tier', 'existing_subscription', 'paid_optional', 'usage_billed', 'compute_only', 'mixed',
] as const;
export type HqCapabilityCost = (typeof HQ_CAPABILITY_COSTS)[number];

/**
 * Explicit Founder-spend assessment of a capability's real running cost.
 *
 * - 'negligible_local': reviewed and found to create no new material spend
 *   (free/local, or already covered inside an existing authorized
 *   subscription's terms).
 * - 'material': reviewed and found able to create material spend (GPU/cloud
 *   compute, storage, hosting, electricity at scale, ...).
 * - 'unassessed': no explicit review yet. Treated exactly like 'material'
 *   by the spend gate — the gate FAILS CLOSED.
 */
export const HQ_CAPABILITY_COST_ASSESSMENTS = ['negligible_local', 'material', 'unassessed'] as const;
export type HqCapabilityCostAssessment = (typeof HQ_CAPABILITY_COST_ASSESSMENTS)[number];

export const HQ_CAPABILITY_MODES = [
  'native_agent', 'claude_plugin', 'agent_skill', 'mcp', 'web_reference',
  'npm_library', 'platform', 'local_model', 'workflow_rule',
] as const;
export type HqCapabilityMode = (typeof HQ_CAPABILITY_MODES)[number];

export const HQ_CAPABILITY_DOMAINS = [
  'coding', 'design', 'ux', 'research', 'components', 'animation', 'image', 'video',
  'ios', 'product', 'retention', 'voice', 'local_ai', 'governance',
] as const;
export type HqCapabilityDomain = (typeof HQ_CAPABILITY_DOMAINS)[number];

export interface HqCapabilityDescriptor {
  id: string;
  title: string;
  kind: HqCapabilityKind;
  priority: HqCapabilityPriority;
  domains: readonly HqCapabilityDomain[];
  purpose: string;
  cost: HqCapabilityCost;
  /**
   * Explicit spend assessment. Absent means 'unassessed', which FAILS CLOSED
   * into the Founder spend gate. Only an explicit 'negligible_local'
   * assessment can let a capability skip the gate.
   */
  costAssessment?: HqCapabilityCostAssessment;
  mode: HqCapabilityMode;
  installRequired: boolean;
  accountRequired: boolean;
  source?: string;
  community?: boolean;
  experimental?: boolean;
  reviewBeforeInstall?: boolean;
}

export const HQ_CAPABILITY_STACK = [
  {
    id: 'claude-code', title: 'Claude Code', kind: 'agent', priority: 'core',
    domains: ['coding', 'design', 'research', 'governance'],
    purpose: 'Primary hands-on coding agent and local project orchestrator.',
    cost: 'existing_subscription', costAssessment: 'negligible_local', mode: 'native_agent', installRequired: true, accountRequired: true,
    source: 'https://code.claude.com/',
  },
  {
    id: 'anthropic-skill-creator', title: 'Anthropic Skill Creator', kind: 'skill', priority: 'core',
    domains: ['coding', 'design', 'research', 'governance'],
    purpose: 'Create, test and improve reusable Jenify-specific skills.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'claude_plugin', installRequired: true, accountRequired: false,
    source: 'https://github.com/anthropics/skills',
  },
  {
    id: 'frontend-design', title: 'Frontend Design', kind: 'skill', priority: 'core',
    domains: ['design', 'ux', 'coding'],
    purpose: 'Create distinctive production-grade interfaces and avoid generic AI aesthetics.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'claude_plugin', installRequired: true, accountRequired: false,
    source: 'https://github.com/anthropics/skills',
  },
  {
    id: 'ui-ux-pro-max', title: 'UI/UX Pro Max', kind: 'skill', priority: 'core',
    domains: ['design', 'ux', 'coding'],
    purpose: 'Design intelligence for styles, palettes, typography, UX rules and platform stacks.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false,
    source: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill', community: true, reviewBeforeInstall: true,
  },
  {
    id: 'refactoring-ui', title: 'Refactoring UI', kind: 'skill', priority: 'core',
    domains: ['design', 'ux'], purpose: 'Audit visual hierarchy, spacing, typography, color and depth.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false,
    source: 'https://github.com/wondelai/skills', community: true,
  },
  {
    id: 'ux-heuristics', title: 'UX Heuristics', kind: 'skill', priority: 'core',
    domains: ['ux', 'design'], purpose: 'Run structured usability and heuristic checks before release.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false,
    source: 'https://github.com/wondelai/skills', community: true,
  },
  {
    id: '21st-mcp', title: '21st MCP', kind: 'mcp', priority: 'core',
    domains: ['components', 'design', 'coding'], purpose: 'Search, inspect, install and generate UI components from an agent.',
    cost: 'mixed', costAssessment: 'material', mode: 'mcp', installRequired: true, accountRequired: true,
    source: 'https://21st.dev/mcp',
  },
  {
    id: 'motion', title: 'Motion', kind: 'library', priority: 'core',
    domains: ['animation', 'coding', 'design'], purpose: 'Production-grade web animation for React, JavaScript and Vue.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'npm_library', installRequired: true, accountRequired: false, source: 'https://motion.dev/',
  },
  {
    id: 'gsap-skills', title: 'GSAP Agent Skills', kind: 'skill', priority: 'core',
    domains: ['animation', 'coding', 'design'], purpose: 'Correct GSAP/ScrollTrigger animation, scrubbing and performance patterns.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'claude_plugin', installRequired: true, accountRequired: false,
    source: 'https://github.com/greensock/gsap-skills',
  },
  {
    id: 'karpathy-claude-md', title: 'Karpathy-style CLAUDE.md Guardrails', kind: 'workflow', priority: 'core',
    domains: ['coding', 'governance'], purpose: 'Reduce guessing/overengineering and require bounded verified changes.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'workflow_rule', installRequired: false, accountRequired: false, community: true,
  },
  {
    id: 'hq-approval-clarification-rules', title: 'HQ Approval & Clarification Rules', kind: 'workflow', priority: 'core',
    domains: ['governance'], purpose: 'Escalate only material ambiguity/Founder gates while routine work continues safely.',
    cost: 'free', costAssessment: 'negligible_local', mode: 'workflow_rule', installRequired: false, accountRequired: false,
  },
  {
    id: 'notebooklm-mcp', title: 'NotebookLM MCP', kind: 'mcp', priority: 'core',
    domains: ['research'], purpose: 'Source-grounded notebook research and research-artifact workflows.',
    cost: 'mixed', costAssessment: 'material', mode: 'mcp', installRequired: true, accountRequired: true,
    source: 'https://github.com/teng-lin/notebooklm-py', community: true, experimental: true, reviewBeforeInstall: true,
  },

  // Design reference sources. These are references, never implied connectors.
  { id: 'mobbin', title: 'Mobbin', kind: 'reference', priority: 'reference_only', domains: ['design', 'ux'], purpose: 'Real production app UI references.', cost: 'mixed', costAssessment: 'material', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://mobbin.com/' },
  { id: 'awwwards', title: 'Awwwards', kind: 'reference', priority: 'reference_only', domains: ['design'], purpose: 'Premium website and interaction references.', cost: 'mixed', costAssessment: 'material', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://www.awwwards.com/' },
  { id: 'cosmos', title: 'Cosmos', kind: 'reference', priority: 'reference_only', domains: ['design'], purpose: 'Moodboards and visual-direction references.', cost: 'mixed', costAssessment: 'material', mode: 'web_reference', installRequired: false, accountRequired: false },
  { id: 'pinterest', title: 'Pinterest', kind: 'reference', priority: 'reference_only', domains: ['design'], purpose: 'Broad visual inspiration and discovery.', cost: 'free', costAssessment: 'negligible_local', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://www.pinterest.com/' },
  { id: 'namethatui', title: 'NameThatUI', kind: 'reference', priority: 'reference_only', domains: ['design', 'ux', 'components'], purpose: 'Identify UI patterns/components by their correct terminology.', cost: 'free', costAssessment: 'negligible_local', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://namethatui.com/' },

  { id: 'skiper-ui', title: 'Skiper UI', kind: 'reference', priority: 'strong', domains: ['components', 'design'], purpose: 'Secondary React/shadcn component source.', cost: 'mixed', costAssessment: 'material', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://skiper-ui.com/' },
  { id: 'vengeance-ui', title: 'Vengeance UI', kind: 'reference', priority: 'strong', domains: ['components', 'animation', 'design'], purpose: 'Open-source animated/interactive component source.', cost: 'free', costAssessment: 'negligible_local', mode: 'web_reference', installRequired: false, accountRequired: false, source: 'https://www.vengenceui.com/' },
  { id: 'antigravity', title: 'Google Antigravity', kind: 'agent', priority: 'strong', domains: ['coding', 'design', 'research'], purpose: 'Additional agent environment for specialist work.', cost: 'mixed', costAssessment: 'material', mode: 'platform', installRequired: true, accountRequired: true, source: 'https://antigravity.google/' },
  { id: 'nano-banana-2', title: 'Nano Banana 2', kind: 'model', priority: 'strong', domains: ['image', 'design'], purpose: 'Brand/site imagery and creative asset generation.', cost: 'mixed', costAssessment: 'material', mode: 'platform', installRequired: false, accountRequired: true },
  { id: 'chatcut', title: 'ChatCut', kind: 'platform', priority: 'strong', domains: ['video'], purpose: 'Agent-controlled video editing, motion graphics, captions and export.', cost: 'usage_billed', costAssessment: 'material', mode: 'platform', installRequired: true, accountRequired: true, source: 'https://chatcut.io/' },
  { id: 'design-sprint', title: 'Design Sprint', kind: 'skill', priority: 'strong', domains: ['product', 'design', 'ux'], purpose: 'Validate major products/features before expensive implementation.', cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false, source: 'https://github.com/wondelai/skills', community: true },
  { id: 'hooked-ux', title: 'Hooked UX', kind: 'skill', priority: 'strong', domains: ['retention', 'product', 'ux'], purpose: 'Analyze retention loops and recurring-use mechanics.', cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false, source: 'https://github.com/wondelai/skills', community: true },
  { id: 'ios-hig-design', title: 'iOS HIG Design', kind: 'skill', priority: 'strong', domains: ['ios', 'design', 'ux'], purpose: 'Apply Apple platform interaction/accessibility conventions.', cost: 'free', costAssessment: 'negligible_local', mode: 'agent_skill', installRequired: true, accountRequired: false, source: 'https://github.com/wondelai/skills', community: true },
  { id: 'atoms', title: 'Atoms', kind: 'platform', priority: 'strong', domains: ['coding', 'design', 'product', 'video'], purpose: 'Fast AI-assisted website/app prototyping and experiments.', cost: 'mixed', costAssessment: 'material', mode: 'platform', installRequired: false, accountRequired: true, source: 'https://atoms.dev/' },
  { id: 'seedance-2', title: 'Seedance 2', kind: 'model', priority: 'strong', domains: ['video'], purpose: 'Multimodal cinematic video generation through a supported provider.', cost: 'usage_billed', costAssessment: 'material', mode: 'platform', installRequired: false, accountRequired: true },
  { id: 'minimax-h3', title: 'MiniMax H3', kind: 'model', priority: 'strong', domains: ['video', 'local_ai'], purpose: 'Open-weight video-generation candidate for self-hosted Jenify media.', cost: 'compute_only', costAssessment: 'material', mode: 'local_model', installRequired: true, accountRequired: false, experimental: true },

  { id: 'qwen-3-8', title: 'Qwen 3.8', kind: 'model', priority: 'later', domains: ['local_ai', 'coding', 'research'], purpose: 'Future private/local HQ worker option.', cost: 'compute_only', costAssessment: 'material', mode: 'local_model', installRequired: true, accountRequired: false, source: 'https://qwen.ai/' },
  { id: 'caveman', title: 'Caveman', kind: 'workflow', priority: 'later', domains: ['coding', 'governance'], purpose: 'Optional compact-output mode for background agents.', cost: 'free', costAssessment: 'negligible_local', mode: 'workflow_rule', installRequired: true, accountRequired: false, community: true, reviewBeforeInstall: true },
  { id: 'wispr-analytics', title: 'Wispr Analytics', kind: 'platform', priority: 'later', domains: ['voice'], purpose: 'Voice-dictation workflow analytics if Jenify adopts voice-first operation.', cost: 'mixed', costAssessment: 'material', mode: 'platform', installRequired: true, accountRequired: true, community: true, reviewBeforeInstall: true },
  { id: 'animmaster-lib', title: 'Animmaster Lib', kind: 'reference', priority: 'later', domains: ['components', 'animation', 'design'], purpose: 'Optional advanced WebGL/3D/transition component reference.', cost: 'paid_optional', costAssessment: 'material', mode: 'web_reference', installRequired: false, accountRequired: false },
  { id: 'hyliox', title: 'Hyliox', kind: 'skill', priority: 'later', domains: ['design', 'coding'], purpose: 'Commercial premium website workflow to study; prefer Jenify-owned equivalent.', cost: 'paid_optional', costAssessment: 'material', mode: 'agent_skill', installRequired: true, accountRequired: true, source: 'https://hyliox.io/', reviewBeforeInstall: true },
] as const satisfies readonly HqCapabilityDescriptor[];

export type HqCapabilityId = (typeof HQ_CAPABILITY_STACK)[number]['id'];

export const HQ_CAPABILITY_ALIASES = {
  'magic-mcp': '21st-mcp',
  'framer-motion': 'motion',
} as const satisfies Readonly<Record<string, HqCapabilityId>>;

export const HQ_CAPABILITY_INTENTS = [
  'web.build', 'web.audit', 'research.deep', 'media.image', 'media.video',
  'mobile.ios', 'product.validate', 'skills.create', 'local_ai.evaluate',
] as const;
export type HqCapabilityIntent = (typeof HQ_CAPABILITY_INTENTS)[number];

export interface HqCapabilityRecipeStage {
  name: string;
  capabilityIds: readonly HqCapabilityId[];
  optional?: boolean;
}

export const HQ_CAPABILITY_RECIPES: Readonly<Record<HqCapabilityIntent, readonly HqCapabilityRecipeStage[]>> = {
  'web.build': [
    { name: 'reference', capabilityIds: ['mobbin', 'awwwards', 'cosmos', 'pinterest', 'namethatui'], optional: true },
    { name: 'design', capabilityIds: ['frontend-design', 'ui-ux-pro-max'] },
    { name: 'components', capabilityIds: ['21st-mcp', 'skiper-ui', 'vengeance-ui'], optional: true },
    { name: 'animation', capabilityIds: ['motion', 'gsap-skills'], optional: true },
    { name: 'build', capabilityIds: ['claude-code'] },
    { name: 'audit', capabilityIds: ['refactoring-ui', 'ux-heuristics'] },
  ],
  'web.audit': [
    { name: 'visual-polish', capabilityIds: ['refactoring-ui'] },
    { name: 'usability', capabilityIds: ['ux-heuristics'] },
  ],
  // NotebookLM is community/experimental and may be unavailable; it is
  // therefore optional, and the approved fallback — the normal Claude Code
  // research path — is the recipe's required stage.
  'research.deep': [
    { name: 'source-grounding', capabilityIds: ['notebooklm-mcp'], optional: true },
    { name: 'research', capabilityIds: ['claude-code'] },
  ],
  'media.image': [{ name: 'generation', capabilityIds: ['nano-banana-2'] }],
  'media.video': [
    { name: 'edit', capabilityIds: ['chatcut'], optional: true },
    { name: 'generate', capabilityIds: ['seedance-2', 'minimax-h3'], optional: true },
  ],
  'mobile.ios': [{ name: 'platform-design', capabilityIds: ['ios-hig-design', 'ui-ux-pro-max'] }],
  'product.validate': [
    { name: 'validation', capabilityIds: ['design-sprint'] },
    { name: 'retention', capabilityIds: ['hooked-ux'], optional: true },
  ],
  'skills.create': [{ name: 'author-and-evaluate', capabilityIds: ['anthropic-skill-creator'] }],
  'local_ai.evaluate': [{ name: 'candidates', capabilityIds: ['qwen-3-8', 'minimax-h3'], optional: true }],
};

/**
 * Normalize an incoming capability name to the lowercase slug form used by
 * catalog ids and alias keys: lowercased, with every run of whitespace,
 * underscores or other punctuation collapsed to a single hyphen and
 * leading/trailing separators dropped. This lets documented display forms
 * such as 'Magic MCP' or 'Framer Motion' resolve. Catalog ids are already
 * in slug form, so normalization is a no-op for them.
 */
export function normalizeHqCapabilityLookup(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveHqCapabilityId(idOrAlias: string): HqCapabilityId | null {
  const key = normalizeHqCapabilityLookup(idOrAlias);
  if (Object.prototype.hasOwnProperty.call(HQ_CAPABILITY_ALIASES, key)) {
    return HQ_CAPABILITY_ALIASES[key as keyof typeof HQ_CAPABILITY_ALIASES];
  }
  return HQ_CAPABILITY_STACK.some((capability) => capability.id === key)
    ? (key as HqCapabilityId)
    : null;
}

export function getHqCapability(idOrAlias: string): HqCapabilityDescriptor | null {
  const id = resolveHqCapabilityId(idOrAlias);
  return id ? HQ_CAPABILITY_STACK.find((capability) => capability.id === id) ?? null : null;
}

const HQ_BILLABLE_COSTS: readonly HqCapabilityCost[] = ['paid_optional', 'usage_billed', 'mixed'];

/**
 * FAIL CLOSED. A capability requires Founder spend approval when its cost
 * class is inherently billable, when its assessed cost is material, or when
 * its cost has simply never been assessed. Only an explicit
 * 'negligible_local' assessment may skip the gate — so 'compute_only'
 * capabilities (which can require material GPU/cloud compute spend) and any
 * unannotated entry stay behind the gate.
 */
export function capabilityRequiresFounderSpendGate(capability: HqCapabilityDescriptor): boolean {
  if (HQ_BILLABLE_COSTS.includes(capability.cost)) return true;
  return (capability.costAssessment ?? 'unassessed') !== 'negligible_local';
}

/**
 * Automatic selection is only a recommendation. Runtime evidence, permissions,
 * installation/auth state, project policy and Operator authority must still pass.
 */
export function capabilityMayAutoSelect(capability: HqCapabilityDescriptor): boolean {
  if (capabilityRequiresFounderSpendGate(capability)) return false;
  if (capability.accountRequired) return false;
  if (capability.reviewBeforeInstall) return false;
  return capability.priority === 'core' && capability.kind !== 'reference';
}
