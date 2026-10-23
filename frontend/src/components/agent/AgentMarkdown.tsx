import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { nativeMath } from "@/lib/agentMarkdown";
import "katex/dist/katex.min.css";
import "./agent.css";

export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  return <div className="agent-markdown min-w-0 text-sm leading-relaxed break-words">
    <Markdown skipHtml remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
      components={{
        a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
        // Image URLs are links, so a model cannot initiate requests to arbitrary tracking servers.
        img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a> : <span>{alt}</span>,
        table: ({ children }) => <div className="agent-markdown-table"><table>{children}</table></div>,
      }}>{nativeMath(children)}</Markdown>
  </div>;
});
