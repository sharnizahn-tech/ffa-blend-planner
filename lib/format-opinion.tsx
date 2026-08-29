import type { ReactNode } from "react";

const MARKDOWN_BOLD = /\*\*(.+?)\*\*/g;
const AUTO_BOLD =
  /(\bBST\s*\d+\b|\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*MT\b)/gi;

function autoBoldPlain(text: string, keyStart: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = keyStart;

  for (const match of text.matchAll(AUTO_BOLD)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));
    nodes.push(
      <strong key={key++} className="font-bold text-[#173f30]">
        {match[0]}
      </strong>,
    );
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
};

export function parseOpinionText(text: string): ReactNode[] {
  const normalized = text.replace(/\*\*\*(.+?)\*\*\*/g, "**$1**");
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of normalized.matchAll(MARKDOWN_BOLD)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(...autoBoldPlain(normalized.slice(lastIndex, index), key));
      key += 100;
    }
    nodes.push(
      <strong key={key++} className="font-bold text-[#173f30]">
        {match[1]}
      </strong>,
    );
    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    nodes.push(...autoBoldPlain(normalized.slice(lastIndex), key));
  }

  return nodes;
}

export function FormattedOpinion({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#58665e]">
      {parseOpinionText(text)}
    </div>
  );
}
