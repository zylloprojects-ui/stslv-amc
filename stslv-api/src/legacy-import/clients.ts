// NORMALIZE: client names. Only two things are ever done to a name without
// approval: outer and repeated spaces are removed, and letter case is ignored
// when comparing. Names are never merged because they look alike.

export type ClientClassification = "SAFE_NORMALIZATION" | "PROPOSED_ALIAS" | "KEEP_SEPARATE" | "CLIENT_CONFIRMATION_REQUIRED";

/**
 * What the import would do with a name.
 *   EXISTING_CLIENT             a client of that name is already in the database
 *   PROPOSED_NEW_CLIENT         a new client would be created under the master name
 *   ALIAS_OF_PROPOSED_CLIENT    an approved alias: uses the master client
 *   HELD_ALIAS_NOT_APPROVED     a likely alias that has not been approved
 *   HELD_IDENTITY_UNCONFIRMED   the workbooks do not show which customer this is
 */
export type ClientOutcome =
  | "EXISTING_CLIENT"
  | "PROPOSED_NEW_CLIENT"
  | "ALIAS_OF_PROPOSED_CLIENT"
  | "HELD_ALIAS_NOT_APPROVED"
  | "HELD_IDENTITY_UNCONFIRMED";

export interface ClientOccurrence {
  raw: string;
  source: "contracts" | "schedule" | "jobs";
}

/** Evidence that a name used in one workbook is the customer of a contract named differently in another. */
export interface ContractEvidence {
  aliasRaw: string;
  masterRaw: string;
  evidence: string;
}

export interface ApprovedAlias {
  alias: string;
  master: string;
}

export interface ClientName {
  raw: string;
  /** The name with outer and repeated spaces removed. Letter case is as written. */
  normalized: string;
  /** What names are compared by: the normalized name in upper case. */
  key: string;
  occurrences: { contracts: number; schedule: number; jobs: number };
  /** The name the client record would carry. */
  masterName: string;
  masterKey: string;
  classification: ClientClassification;
  confidence: string;
  reason: string;
  outcome: ClientOutcome;
  /** Id of the matching client already in the database, when there is one. */
  existingClientId: string | null;
  /** Look-alike names that are deliberately kept apart. For review only; nothing is merged. */
  lookAlikes: string[];
}

export interface ClientPlan {
  names: ClientName[];
  /** One entry per client record the names lead to. */
  masters: { key: string; name: string; held: boolean; existingClientId: string | null; rawNames: string[] }[];
}

export const normalizeName = (raw: string): string => raw.replace(/\s+/g, " ").trim();
export const nameKey = (raw: string): string => normalizeName(raw).toUpperCase();

const squash = (key: string): string => key.replace(/[^A-Z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const table = Array.from({ length: a.length + 1 }, (_, row) => [row, ...Array<number>(b.length).fill(0)]);

  for (let column = 1; column <= b.length; column += 1) {
    (table[0] as number[])[column] = column;
  }
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      (table[row] as number[])[column] = Math.min(
        ((table[row - 1] as number[])[column] as number) + 1,
        ((table[row] as number[])[column - 1] as number) + 1,
        ((table[row - 1] as number[])[column - 1] as number) + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
  }

  return (table[a.length] as number[])[b.length] as number;
}

// Words too common in business names, and place names, to suggest that two names are related.
const COMMON_WORDS = new Set([
  "HOTEL", "MALL", "TECH", "CENTER", "CENTRE", "REAL", "ESTATE", "BANK", "POWER", "GROUP", "SERVICE", "SERVICES",
  "GLOBAL", "HOUSE", "TOWER", "COMPLEX", "GARDEN", "FRONT", "WATER", "CONSTRUCTION", "BUSINESS", "PLAZA", "UNIVERSAL",
  "TRADING", "COMPANY", "INTERNATIONAL", "NATIONAL", "GENERAL", "OMAN", "MUSCAT", "SOHAR", "SALALAH", "NIZWA",
]);

const sameLetters = (a: string, b: string): boolean => [...a].sort().join("") === [...b].sort().join("");

/** Why two different names might be confused, or null. Used to list look-alikes for review, never to merge. */
function resemblance(a: string, b: string): string | null {
  const [squashedA, squashedB] = [squash(a), squash(b)];

  if (editDistance(squashedA, squashedB) === 1) {
    return "one character apart";
  }

  const wordsA = a.split(/[^A-Z0-9&]+/).filter(Boolean);
  const wordsB = b.split(/[^A-Z0-9&]+/).filter(Boolean);
  const shared = wordsA.filter((word) => word.length >= 5 && !COMMON_WORDS.has(word) && wordsB.includes(word));

  if (shared.length > 0) {
    return `shared name "${shared.join(" ")}"`;
  }
  if (wordsA.length > 1 && wordsB.length > 1 && wordsA[0] === wordsB[0] && (wordsA[0] as string).length <= 3 && wordsA[0] !== "AL") {
    return `same prefix "${wordsA[0]}"`;
  }

  for (const wordA of wordsA) {
    for (const wordB of wordsB) {
      if (wordA === wordB || wordA.length < 4 || wordB.length < 4 || COMMON_WORDS.has(wordA) || COMMON_WORDS.has(wordB)) {
        continue;
      }
      // The same letters in another order, or a longer word one letter apart.
      if (sameLetters(wordA, wordB) || (Math.min(wordA.length, wordB.length) >= 5 && editDistance(wordA, wordB) === 1)) {
        return `similar word ${wordA}~${wordB}`;
      }
    }
  }

  return null;
}

export function planClients(
  occurrences: ClientOccurrence[],
  contractNames: string[],
  evidence: ContractEvidence[],
  approvedAliases: ApprovedAlias[],
  existingClients: { id: string; name: string }[]
): ClientPlan {
  const counts = new Map<string, { contracts: number; schedule: number; jobs: number }>();

  for (const occurrence of occurrences) {
    const count = counts.get(occurrence.raw) ?? { contracts: 0, schedule: 0, jobs: 0 };

    count[occurrence.source] += 1;
    counts.set(occurrence.raw, count);
  }

  const raws = [...counts.keys()].sort((a, b) => nameKey(a).localeCompare(nameKey(b)) || a.localeCompare(b));
  const keys = [...new Set(raws.map(nameKey))].sort();
  const rawsOf = (key: string) => raws.filter((raw) => nameKey(raw) === key);
  const total = (key: string) =>
    rawsOf(key).reduce((sum, raw) => {
      const count = counts.get(raw) as ClientName["occurrences"];

      return sum + count.contracts + count.schedule + count.jobs;
    }, 0);
  const contractKeys = new Set(contractNames.map(nameKey));

  // --- alias proposals -----------------------------------------------------
  // Each maps one key to the key of its proposed master. A proposal is only a
  // proposal: it is applied when, and only when, it has been approved.
  const proposals = new Map<string, { master: string; rule: string; evidence: string }>();
  const propose = (aliasKey: string, masterKey: string, rule: string, why: string) => {
    if (aliasKey === masterKey) {
      return;
    }

    const existing = proposals.get(aliasKey);

    if (existing && existing.master === masterKey) {
      existing.rule += ` + ${rule}`;
      existing.evidence += `; ${why}`;
    } else if (!existing) {
      proposals.set(aliasKey, { master: masterKey, rule, evidence: why });
    }
  };

  // Rule: the two names are the same once spaces and punctuation are removed.
  // The name of a contract in the register is the master; otherwise the more used name is.
  for (let first = 0; first < keys.length; first += 1) {
    for (let second = first + 1; second < keys.length; second += 1) {
      const [a, b] = [keys[first] as string, keys[second] as string];

      if (squash(a) !== squash(b)) {
        continue;
      }

      const master = contractKeys.has(a) !== contractKeys.has(b) ? (contractKeys.has(a) ? a : b) : total(a) >= total(b) ? a : b;

      propose(master === a ? b : a, master, "spacing only", `identical once spaces and punctuation are removed ("${squash(a)}")`);
    }
  }

  // Rule: the schedule rows under this name reconcile to exactly one contract held under the other name.
  for (const item of evidence) {
    propose(nameKey(item.aliasRaw), nameKey(item.masterRaw), "contract reconciliation", item.evidence);
  }

  const proposedMaster = (key: string): string => proposals.get(key)?.master ?? key;
  const masterKeys = [...new Set(keys.map(proposedMaster))].sort();

  // --- identity that the workbooks cannot settle ----------------------------
  // One master name is the opening words of another: a short form that could be either customer.
  const unconfirmed = new Map<string, string[]>();

  for (const a of masterKeys) {
    for (const b of masterKeys) {
      if (a !== b && b.startsWith(`${a} `)) {
        unconfirmed.set(a, [...(unconfirmed.get(a) ?? []), b]);
        unconfirmed.set(b, [...(unconfirmed.get(b) ?? []), a]);
      }
    }
  }

  // --- approvals ------------------------------------------------------------
  const approved = new Set<string>();

  for (const approval of approvedAliases) {
    const [aliasKey, masterKey] = [nameKey(approval.alias), nameKey(approval.master)];
    const proposal = proposals.get(aliasKey);

    if (!proposal || proposal.master !== masterKey) {
      throw new Error(`The approved alias "${approval.alias}" -> "${approval.master}" is not an alias this import proposes. Nothing was approved.`);
    }
    if (unconfirmed.has(masterKey)) {
      throw new Error(`The alias "${approval.alias}" -> "${approval.master}" cannot be approved while the identity of "${approval.master}" is unconfirmed.`);
    }

    approved.add(aliasKey);
  }

  // --- look-alikes, for review only -----------------------------------------
  const lookAlikes = new Map<string, string[]>();

  for (let first = 0; first < masterKeys.length; first += 1) {
    for (let second = first + 1; second < masterKeys.length; second += 1) {
      const [a, b] = [masterKeys[first] as string, masterKeys[second] as string];
      const why = unconfirmed.get(a)?.includes(b) ? null : resemblance(a, b);

      if (why) {
        lookAlikes.set(a, [...(lookAlikes.get(a) ?? []), `${b} (${why})`]);
        lookAlikes.set(b, [...(lookAlikes.get(b) ?? []), `${a} (${why})`]);
      }
    }
  }

  // --- the name each client record would carry --------------------------------
  const existingByKey = new Map(existingClients.map((client) => [nameKey(client.name), client.id]));
  const masterName = (masterKey: string): string => {
    const candidates = rawsOf(masterKey);
    // The spelling used in the contract register, else the most used spelling.
    const fromContracts = contractNames.find((name) => nameKey(name) === masterKey);

    if (fromContracts !== undefined) {
      return normalizeName(fromContracts);
    }

    // Count each spelling once spaces are normalized; ties go to the spelling that sorts first.
    const uses = new Map<string, number>();

    for (const raw of candidates) {
      const count = counts.get(raw) as ClientName["occurrences"];

      uses.set(normalizeName(raw), (uses.get(normalizeName(raw)) ?? 0) + count.contracts + count.schedule + count.jobs);
    }

    return [...uses.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] as string;
  };

  const names: ClientName[] = raws.map((raw) => {
    const key = nameKey(raw);
    const masterKey = proposedMaster(key);
    const proposal = proposals.get(key);
    const normalized = normalizeName(raw);
    const existingClientId = existingByKey.get(masterKey) ?? null;
    const others = lookAlikes.get(masterKey) ?? [];
    let classification: ClientClassification;
    let confidence: string;
    let reason: string;
    let outcome: ClientOutcome;

    if (unconfirmed.has(masterKey)) {
      classification = "CLIENT_CONFIRMATION_REQUIRED";
      confidence = "UNKNOWN";
      reason = `"${masterKey}" and ${(unconfirmed.get(masterKey) as string[]).map((other) => `"${other}"`).join(", ")}: one name is the short form of the other, and the workbooks do not show whether they are the same customer`;
      if (proposal) {
        reason += `. ${key} -> ${masterKey}: ${proposal.evidence}`;
      }
      outcome = "HELD_IDENTITY_UNCONFIRMED";
    } else if (proposal) {
      classification = "PROPOSED_ALIAS";
      confidence = "HIGH";
      reason = `${proposal.rule}: ${proposal.evidence}`;
      outcome = approved.has(key) ? "ALIAS_OF_PROPOSED_CLIENT" : "HELD_ALIAS_NOT_APPROVED";
    } else {
      const changed = normalized !== raw || rawsOf(key).length > 1;

      classification = changed ? "SAFE_NORMALIZATION" : "KEEP_SEPARATE";
      confidence = changed || others.length === 0 ? "CERTAIN" : "DEFAULT (no evidence of identity)";
      reason = changed
        ? `spaces${rawsOf(key).length > 1 ? " or letter case" : ""} only: ${JSON.stringify(raw)} -> ${JSON.stringify(masterName(masterKey))}`
        : others.length > 0
          ? "distinct name; no workbook evidence links it to its look-alikes"
          : "distinct name, used as written";
      outcome = existingClientId !== null ? "EXISTING_CLIENT" : "PROPOSED_NEW_CLIENT";
    }

    if (outcome === "ALIAS_OF_PROPOSED_CLIENT" && existingClientId !== null) {
      outcome = "EXISTING_CLIENT";
    }

    return {
      raw,
      normalized,
      key,
      occurrences: counts.get(raw) as ClientName["occurrences"],
      masterName: masterName(masterKey),
      masterKey,
      classification,
      confidence,
      reason,
      outcome,
      existingClientId: outcome.startsWith("HELD") ? null : existingClientId,
      lookAlikes: others,
    };
  });

  const masters = masterKeys.map((key) => ({
    key,
    name: masterName(key),
    held: unconfirmed.has(key),
    existingClientId: unconfirmed.has(key) ? null : (existingByKey.get(key) ?? null),
    rawNames: names.filter((name) => name.masterKey === key).map((name) => name.raw),
  }));

  return { names, masters };
}
