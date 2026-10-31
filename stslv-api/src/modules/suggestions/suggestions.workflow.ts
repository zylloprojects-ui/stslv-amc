import type { AuthContext } from "../auth/access";

// The status workflow of a suggestion, and who may move it. Checked by the
// API on every change; the web app only offers what these rules allow.
//
//   Submitted → Under Review → In Progress → Resolved → Closed
//   Resolved or Closed → Reopened → (back into review)
//
// A reviewer may skip steps (a duplicate can be closed straight away), but
// every step is recorded. The submitter may only reopen a Resolved suggestion.

export const STATUSES = ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED", "REOPENED"] as const;
export type SuggestionStatus = (typeof STATUSES)[number];

export const CATEGORIES = ["IMPROVEMENT", "BUG", "FEATURE"] as const;
export type SuggestionCategory = (typeof CATEGORIES)[number];

/** Statuses that still need a reviewer's attention. */
export const OPEN_STATUSES: readonly SuggestionStatus[] = ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "REOPENED"];

const REVIEWER_TRANSITIONS: Record<SuggestionStatus, readonly SuggestionStatus[]> = {
  SUBMITTED: ["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  UNDER_REVIEW: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["UNDER_REVIEW", "RESOLVED", "CLOSED"],
  REOPENED: ["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
};

const SUBMITTER_TRANSITIONS: Record<SuggestionStatus, readonly SuggestionStatus[]> = {
  SUBMITTED: [],
  UNDER_REVIEW: [],
  IN_PROGRESS: [],
  REOPENED: [],
  RESOLVED: ["REOPENED"],
  CLOSED: [],
};

/** Sees every suggestion and its internal notes (Suggestions Review: View). */
export function canSeeAllSuggestions(auth: AuthContext): boolean {
  return auth.permissions.has("SUGGESTIONS_REVIEW:VIEW");
}

/** Reviewers manage every suggestion: respond, add internal notes, change status, assign (Suggestions Review: Edit). */
export function isReviewer(auth: AuthContext): boolean {
  return auth.permissions.has("SUGGESTIONS_REVIEW:EDIT");
}

/** Submitting, commenting on one's own suggestion and reopening it (My Suggestions: Create). */
export function canSubmitSuggestions(auth: AuthContext): boolean {
  return auth.permissions.has("SUGGESTIONS:CREATE");
}

export type Actor = "REVIEWER" | "SUBMITTER";

export function allowedTransitions(from: SuggestionStatus, actor: Actor): readonly SuggestionStatus[] {
  return (actor === "REVIEWER" ? REVIEWER_TRANSITIONS : SUBMITTER_TRANSITIONS)[from];
}

export function canTransition(from: SuggestionStatus, to: SuggestionStatus, actor: Actor): boolean {
  return allowedTransitions(from, actor).includes(to);
}

/**
 * What a change to the given status must carry. Resolving records how it was
 * resolved; closing anything not yet resolved, and reopening, record why.
 */
export function noteRequirement(from: SuggestionStatus, to: SuggestionStatus): "resolution" | "reason" | null {
  if (to === "RESOLVED") return "resolution";
  if (to === "REOPENED") return "reason";
  if (to === "CLOSED" && from !== "RESOLVED") return "reason";
  return null;
}

/** The reference shown to users, derived from the id: SUG-00042. */
export function referenceOf(id: string): string {
  return `SUG-${id.padStart(5, "0")}`;
}

/** The id inside a reference typed by a user ("SUG-00042", "sug42", "42"), or null when it is not one. */
export function idFromReference(value: string): string | null {
  const match = /^(?:SUG-?)?0*([1-9]\d{0,17})$/i.exec(value.trim());

  return match ? (match[1] as string) : null;
}
