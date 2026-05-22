const DEFAULT_ADJECTIVES = [
  "able",
  "agile",
  "alert",
  "amber",
  "ample",
  "apt",
  "arctic",
  "avid",
  "bold",
  "brave",
  "bright",
  "brisk",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "daring",
  "dawn",
  "eager",
  "early",
  "fair",
  "fast",
  "fierce",
  "fine",
  "fresh",
  "gentle",
  "golden",
  "grand",
  "happy",
  "honest",
  "jolly",
  "keen",
  "kind",
  "lively",
  "lucky",
  "merry",
  "mighty",
  "nimble",
  "noble",
  "novel",
  "patient",
  "proud",
  "quick",
  "quiet",
  "rapid",
  "ready",
  "sharp",
  "smart",
  "solid",
  "steady",
  "swift",
  "tidy",
  "vivid",
  "warm",
  "wise",
] as const;

const DEFAULT_NOUNS = [
  "badger",
  "beacon",
  "bison",
  "brook",
  "cedar",
  "comet",
  "coral",
  "coyote",
  "crane",
  "dolphin",
  "eagle",
  "ember",
  "falcon",
  "finch",
  "forest",
  "fox",
  "gecko",
  "glade",
  "harbor",
  "hawk",
  "heron",
  "island",
  "jaguar",
  "koala",
  "lagoon",
  "lemur",
  "lynx",
  "maple",
  "meadow",
  "otter",
  "panda",
  "panther",
  "pelican",
  "phoenix",
  "puma",
  "raven",
  "reef",
  "river",
  "salmon",
  "sparrow",
  "summit",
  "tiger",
  "valley",
  "violet",
  "walrus",
  "willow",
  "wolf",
  "wren",
  "yak",
  "zephyr",
] as const;

const usedInstanceNames = new Set<string>();

let adjectives: readonly string[] = DEFAULT_ADJECTIVES;
let nouns: readonly string[] = DEFAULT_NOUNS;
let randomSource: () => number = Math.random;

function normalizeRandomIndex(limit: number): number {
  const value = randomSource();
  if (!Number.isFinite(value)) return 0;
  return Math.min(limit - 1, Math.max(0, Math.floor(value * limit)));
}

function nameAt(index: number): string {
  const adjective = adjectives[Math.floor(index / nouns.length)];
  const noun = nouns[index % nouns.length];
  return `${adjective}-${noun}`;
}

export function generateSubagentInstanceName(): string {
  const capacity = adjectives.length * nouns.length;
  if (usedInstanceNames.size >= capacity) {
    throw new Error(
      "No unused subagent instance names remain for this session.",
    );
  }
  const start = normalizeRandomIndex(capacity);
  for (let offset = 0; offset < capacity; offset += 1) {
    const candidate = nameAt((start + offset) % capacity);
    if (!usedInstanceNames.has(candidate)) {
      usedInstanceNames.add(candidate);
      return candidate;
    }
  }
  throw new Error("No unused subagent instance names remain for this session.");
}

export function resetSubagentInstanceNamesForTest() {
  usedInstanceNames.clear();
  adjectives = DEFAULT_ADJECTIVES;
  nouns = DEFAULT_NOUNS;
  randomSource = Math.random;
}

export function configureSubagentInstanceNamesForTest(options: {
  adjectives?: readonly string[];
  nouns?: readonly string[];
  randomSource?: () => number;
}) {
  usedInstanceNames.clear();
  adjectives = options.adjectives ?? DEFAULT_ADJECTIVES;
  nouns = options.nouns ?? DEFAULT_NOUNS;
  randomSource = options.randomSource ?? Math.random;
}
