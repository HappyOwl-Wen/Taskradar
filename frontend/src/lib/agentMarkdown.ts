/** Normalize native math delimiters without changing fenced or inline code. */
export function nativeMath(source: string): string {
  const normalize = (part: string) => part
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula: string) => `\n$$\n${formula}\n$$\n`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_, formula: string) => `$$${formula}$$`);
  const code = /(`+)(?!`)[\s\S]*?\1(?!`)|(~{3,})(?!~)[\s\S]*?\2(?!~)/g;
  let result = "", cursor = 0;
  for (const match of source.matchAll(code)) {
    result += normalize(source.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return result + normalize(source.slice(cursor));
}
