import { z } from 'zod';

/**
 * A reviewer / team member (ACR-10 Team + ACR-11 Profile). The pipeline is the
 * SYSTEM OF RECORD for reviewer identity (the panel's auth allow-list mirrors it).
 *
 * `review_count` is deliberately NOT on this entity — it is DERIVED per-member from
 * the reviews audit log (by `approver` = `email`) at read time, so it can never
 * drift from the real decision history. The member row holds only stable identity.
 */
export const TeamRole = z.enum(['admin', 'reviewer']);
export type TeamRole = z.infer<typeof TeamRole>;

export const TeamMemberStatus = z.enum([
  /** A member who has signed in / been activated. */
  'active',
  /** Invited but not yet active. */
  'invited',
]);
export type TeamMemberStatus = z.infer<typeof TeamMemberStatus>;

export const TeamMemberSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** The auth identity — the reviews audit log keys on this (as `approver`). */
  email: z.string().email(),
  role: TeamRole,
  status: TeamMemberStatus,
  /** ISO-8601 creation timestamp. */
  created_at: z.string().min(1),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/**
 * A team member projected for the admin "Team & users" screen — the stored identity
 * PLUS the derived `review_count` (decisions in the reviews audit log by this
 * member's email). Pure shape; the count is supplied by the use-case.
 */
export interface TeamMemberView {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: TeamMemberStatus;
  /** Number of review decisions this member has made (derived from the audit log). */
  review_count: number;
}

/** Project a member + its derived review count into the panel view (pure). */
export function toTeamMemberView(member: TeamMember, reviewCount: number): TeamMemberView {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    review_count: reviewCount,
  };
}
