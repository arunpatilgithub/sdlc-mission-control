import type { ReactNode } from "react";
import { parsePlanSections, type Block, type PlanSection, type Span } from "./plan-parser";

export type { PlanSection } from "./plan-parser";

/**
 * Renders parsed plan sections as React nodes.
 *
 * Never uses dangerouslySetInnerHTML: plan text comes from an LLM call seeded partly
 * by ADO story text nobody here controls, so every run of text stays a React text
 * node and is escaped automatically. All parsing lives in ./plan-parser.
 */
export function planSections(markdown: string): Array<{ heading: string | null; content: ReactNode }> {
  return parsePlanSections(markdown).map((section) => ({
    heading: section.heading,
    content: renderBlocks(section),
  }));
}

function renderBlocks(section: PlanSection): ReactNode {
  return <>{section.blocks.map((block, index) => renderBlock(block, index))}</>;
}

function renderBlock(block: Block, key: number): ReactNode {
  if (block.kind === "paragraph") return <p key={key}>{renderSpans(block.spans)}</p>;
  if (block.ordered) {
    return <ol key={key}>{block.items.map((item, i) => <li key={i} value={item.number ?? undefined}>{renderSpans(item.spans)}</li>)}</ol>;
  }
  return <ul key={key}>{block.items.map((item, i) => <li key={i}>{renderSpans(item.spans)}</li>)}</ul>;
}

function renderSpans(spans: Span[]): ReactNode[] {
  return spans.map((span, index) => {
    if (span.kind === "strong") return <strong key={index}>{span.text}</strong>;
    if (span.kind === "code") return <code key={index}>{span.text}</code>;
    return span.text;
  });
}
