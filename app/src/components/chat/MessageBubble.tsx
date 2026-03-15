import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  streaming?: boolean;
}

export default memo(function MessageBubble({ text, streaming }: Props) {
  return (
    <div className={`msg-bubble${streaming ? " streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});
