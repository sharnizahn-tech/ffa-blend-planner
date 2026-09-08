import type { ReactNode } from "react";

const MARKDOWN_BOLD = /\*\*(.+?)\*\*/g;
const AUTO_BOLD =
  /(\bBST\s*\d+\b|\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*MT\b)/gi;
const BULLET_LINE = /^[-•]\s+/;

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

// Splits the response into blank-line-separated blocks, then renders any
// block whose every line starts with "- " (the Quick Summary mode's format)
// as a real dotted bullet list instead of raw dashes — everything else
// renders as a plain paragraph, same as before.
export function FormattedOpinion({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2.5 text-sm leading-relaxed text-[#58665e]">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const isBulletBlock = lines.length > 0 && lines.every((line) => BULLET_LINE.test(line.trim()));

        if (isBulletBlock) {
          return (
            <ul key={i} className="space-y-1.5">
              {lines.map((line, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-[#00b14f]" />
                  <span className="whitespace-pre-wrap">
                    {parseOpinionText(line.trim().replace(BULLET_LINE, ""))}
                  </span>
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={i} className="whitespace-pre-wrap">
            {parseOpinionText(block)}
          </p>
        );
      })}
    </div>
  );
}
