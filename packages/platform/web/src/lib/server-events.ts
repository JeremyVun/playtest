export interface ServerEvent {
  event: string;
  data: WebDynamic;
}

/** Decode one SSE block. Unknown/comment-only blocks are ignored. */
export function decodeServerEvent(block: string): ServerEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}
