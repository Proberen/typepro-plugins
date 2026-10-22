import { Fragment, type ReactNode } from "react";
import { notebook } from "./sdk";

function inline(value: string, openNote: (id: string) => void): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  const output: ReactNode[] = [];
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    const at = match.index ?? 0, part = match[0];
    if (at > start) output.push(value.slice(start, at));
    if (part.startsWith("`")) output.push(<code key={at}>{part.slice(1, -1)}</code>);
    else if (part.startsWith("**")) output.push(<strong key={at}>{part.slice(2, -2)}</strong>);
    else if (part.startsWith("*")) output.push(<em key={at}>{part.slice(1, -1)}</em>);
    else {
      const link = part.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      const note = link[2].match(/^typepro:\/\/note\/([0-9a-f-]{36})$/i);
      if (note) output.push(<button className="assistant-note-link" key={at} onClick={() => openNote(note[1])}>{link[1]}</button>);
      else if (/^https?:\/\//i.test(link[2])) output.push(<a key={at} href={link[2]} onClick={event => { event.preventDefault(); void notebook.ui.openExternal(link[2]).catch(() => {}); }} rel="noreferrer">{link[1]}</a>);
      else output.push(link[1]);
    }
    start = at + part.length;
  }
  if (start < value.length) output.push(value.slice(start));
  return output;
}

/** Model text is rendered as React nodes. Raw HTML is always text, never executable DOM. */
export default function MarkdownText({ text, onOpenDocument }: { text: string; onOpenDocument: (id: string) => void }) {
  const lines = text.split("\n"), blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})([^ ]*)/);
    if (fence) {
      const start = index++, body: string[] = [];
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<div className="assistant-code" key={start}>{fence[2] && <span>{fence[2]}</span>}<pre><code>{body.join("\n")}</code></pre></div>);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const start = index, cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
      const headers = cells(line), rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) rows.push(cells(lines[index++]));
      blocks.push(<div className="assistant-table" key={start}><table><thead><tr>{headers.map((header, column) => <th key={column}>{inline(header, onOpenDocument)}</th>)}</tr></thead><tbody>{rows.map((row, offset) => <tr key={offset}>{headers.map((_, column) => <td key={column}>{inline(row[column] || "", onOpenDocument)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { blocks.push(<p className={`assistant-heading assistant-h${heading[1].length}`} key={index}>{inline(heading[2], onOpenDocument)}</p>); index++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={index++} />); continue; }
    const bullet = line.match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
    if (bullet) {
      const start = index, ordered = /^\s*\d+\./.test(line), items: ReactNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
        if (!item) break;
        items.push(<li key={index++}>{inline(item[1], onOpenDocument)}</li>);
      }
      blocks.push(ordered ? <ol key={start}>{items}</ol> : <ul key={start}>{items}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const start = index, quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoted.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={start}>{inline(quoted.join("\n"), onOpenDocument)}</blockquote>);
      continue;
    }
    const start = index, paragraph: string[] = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*[-*+] |\s*\d+\. |>)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={start}>{paragraph.map((part, offset) => <Fragment key={offset}>{offset > 0 && <br />}{inline(part, onOpenDocument)}</Fragment>)}</p>);
  }
  return <div className="assistant-markdown">{blocks}</div>;
}
