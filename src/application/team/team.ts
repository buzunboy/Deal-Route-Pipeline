import {
  TeamRole,
  TeamMemberSchema,
  MissingApproverError,
  InvalidPatchError,
  toTeamMemberView,
  type TeamMember,
  type TeamMemberView,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';

/** Inputs to invite/register a team member (ACR-10 Team). */
export interface InviteMemberInput {
  approver: string;
  name: string;
  email: string;
  /** 'admin' | 'reviewer'; defaults to 'reviewer'. */
  role?: string;
}

/**
 * Team / reviewer registry + profile (ACR-10 Team + ACR-11 Profile). The pipeline is
 * the SYSTEM OF RECORD for reviewer identity (the admin panel's auth allow-list
 * mirrors it). Every mutation requires an approver (no anonymous identity changes).
 *
 * `review_count` on the Team screen is DERIVED from the reviews audit log by the
 * member's email (= the `approver` recorded on each decision), so it can never drift
 * from the real decision history.
 */
export class TeamUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** The Team & users screen: every member + its derived review count. */
  async listTeam(): Promise<TeamMemberView[]> {
    const [members, counts] = await Promise.all([
      this.db.team.list(),
      this.db.reviews.countByApprover(),
    ]);
    return members.map((m) => toTeamMemberView(m, counts.get(m.email) ?? 0));
  }

  /**
   * Invite / register a member. Idempotent on email (re-inviting updates name/role).
   * A new member starts `invited`; re-inviting an existing one keeps their status.
   * Boundary-validates role + email through the domain schema (never trust raw input).
   */
  async inviteMember(input: InviteMemberInput): Promise<TeamMember> {
    this.assertApprover(input.approver, 'invite-member');
    const email = input.email.trim().toLowerCase();
    const role = TeamRole.safeParse(input.role ?? 'reviewer');
    if (!role.success) {
      throw new InvalidPatchError('role must be "admin" or "reviewer"', ['role']);
    }
    const existing = await this.db.team.getByEmail(email);
    const member: TeamMember = {
      id: existing?.id ?? newId(),
      name: input.name.trim(),
      email,
      role: role.data,
      // Keep an existing member's status; a brand-new one is `invited`.
      status: existing?.status ?? 'invited',
      created_at: existing?.created_at ?? this.clock.nowIso(),
    };
    // Boundary-validate the assembled member (rejects e.g. a non-email / blank name).
    const parsed = validateMember(member);
    await this.db.team.upsert(parsed);
    this.logger.info('team member invited/updated', {
      approver: input.approver,
      email,
      role: role.data,
      new: existing === null,
    });
    return parsed;
  }

  /**
   * Update the editable display name for a reviewer's OWN profile (ACR-11). Keyed by
   * the approver's email identity. Throws if the approver has no member row (they
   * must exist in the registry first). Only the name is mutable here — email is the
   * auth identity, role/status are admin actions (inviteMember).
   */
  async updateProfile(approverEmail: string, name: string): Promise<TeamMember> {
    this.assertApprover(approverEmail, 'update-profile');
    const trimmedName = name.trim();
    if (trimmedName === '') throw new InvalidPatchError('name is required', ['name']);
    const email = approverEmail.trim().toLowerCase();
    const existing = await this.db.team.getByEmail(email);
    if (existing === null) {
      throw new InvalidPatchError(`no team member for "${approverEmail}"`, ['approver']);
    }
    const updated: TeamMember = { ...existing, name: trimmedName };
    await this.db.team.upsert(updated);
    this.logger.info('profile name updated', { email });
    return updated;
  }

  private assertApprover(approver: string, action: string): void {
    if (approver.trim() === '') throw new MissingApproverError(action);
  }
}

/** Boundary-validate a member, raising InvalidPatchError (→ 400) on a bad shape. */
function validateMember(member: TeamMember): TeamMember {
  // Re-parse through the schema so e.g. a non-email or blank name is a 400, not a
  // silent bad row (never trust assembled input before it reaches the store).
  const parsed = TeamMemberSchema.safeParse(member);
  if (!parsed.success) {
    throw new InvalidPatchError(
      `invalid team member: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      parsed.error.issues.map((i) => i.path.join('.')),
    );
  }
  return parsed.data;
}
