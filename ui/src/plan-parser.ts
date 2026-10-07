/**
 * Pure parsing of planning-agent output. Deliberately contains no JSX: the plan text
 * is the single source for both the on-screen rendering and the default ADO Task
 * description, so the "what does this plan actually say" logic lives here, once, and
 * is directly unit-testable.
 */

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string };

export type Block =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Array<{ spans: Span[]; number: number | null }> };

export type PlanSection = {
  heading: string | null;
  blocks: Block[];
};

/**
 * Removes fenced blocks (```…```) and their contents.
 *
 * The planning prompt asks the agent to end its response with a fenced JSON block
 * describing repository scope. That block is machine plumbing: it's parsed separately
 * into a RepoScope and must not leak into anything a human reads — neither the
 * rendered plan nor the ADO Task description this text seeds.
 *
 * An unterminated fence drops everything after it, which is the safe direction: better
 * to omit a trailing fragment than to surface raw JSON as prose.
 */
export function stripFencedBlocks(markdown: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parsePlanSections(markdown: string): PlanSection[] {
  const sections: PlanSection[] = [];
  let heading: string | null = null;
  let blocks: Block[] = [];
  let items: Array<{ spans: Span[]; number: number | null }> = [];
  let ordered: boolean | null = null;

  const flushList = () => {
    if (ordered === null || items.length === 0) { ordered = null; items = []; return; }
    blocks.push({ kind: "list", ordered, items });
    ordered = null;
    items = [];
  };
  const flushSection = () => {
    flushList();
    if (heading !== null || blocks.length > 0) sections.push({ heading, blocks });
    blocks = [];
  };

  for (const line of stripFencedBlocks(markdown).split("\n")) {
    const trimmed = line.trimEnd();
    const headingMatch = trimmed.match(/^#{1,4}\s+(.*)$/);
    const orderedMatch = trimmed.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bulletedMatch = trimmed.match(/^\s*[-*]\s+(.*)$/);

    if (headingMatch) {
      flushSection();
      heading = headingMatch[1].trim();
      continue;
    }
    if (orderedMatch) {
      if (ordered !== true) flushList();
      ordered = true;
      // The source numeral is carried through because agents often separate numbered
      // items with prose, which forces a new list here; without it each fragment
      // would restart its visible numbering at 1.
      items.push({ spans: parseSpans(orderedMatch[2]), number: Number(orderedMatch[1]) });
      continue;
    }
    if (bulletedMatch) {
      if (ordered !== false) flushList();
      ordered = false;
      items.push({ spans: parseSpans(bulletedMatch[1]), number: null });
      continue;
    }
    flushList();
    if (trimmed.trim() === "") continue;
    blocks.push({ kind: "paragraph", spans: parseSpans(trimmed) });
  }
  flushSection();
  return sections;
}

export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) spans.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    if (match[1] !== undefined) spans.push({ kind: "strong", text: match[1] });
    else if (match[2] !== undefined) spans.push({ kind: "code", text: match[2] });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) spans.push({ kind: "text", text: text.slice(lastIndex) });
  return spans;
}
