import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  streaming?: boolean;
}

/** Safe link component — blocks javascript:, data:, vbscript: URLs */
const SafeLink = ({ href, children }: { href?: string; children?: React.ReactNode }) => {
  const safe = href && /^https?:\/\/|^#|^mailto:/i.test(href);
  return safe
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
};

export default memo(function MessageBubble({ text, streaming }: Props) {
  return (
    <div className={`msg-bubble${streaming ? " streaming" : ""}`}>
      {streaming ? (
        // Raw text during streaming — avoids O(n^2) markdown re-parsing per chunk
        <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: SafeLink }}>
          {text}
        </ReactMarkdown>
      )}
    </div>
  );
});
