import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChartGallery from "./ChartGallery.jsx";
import Icon from "./Icon.jsx";
import ToolTrace from "./ToolTrace.jsx";

const time = (ts) => new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

export default function ChatMessage({ message, compact = false }) {
  const { role, content, charts, trace, sources, error, createdAt, document } = message;

  if (role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">
          {document && (
            <span className="msg-doc">
              <Icon name="file" size={13} /> {document.title}
            </span>
          )}
          <p>{content}</p>
          <span className="time">{time(createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`msg assistant ${compact ? "compact" : ""}`}>
      <div className="avatar" aria-hidden="true">
        <img src="/logo-icon.png" alt="" />
      </div>
      <div className={`bubble ${error ? "error" : ""}`}>
        {trace?.length > 0 && <ToolTrace trace={trace} sources={sources} />}
        <div className="markdown">
          {error ? (
            <p className="error-text">
              <Icon name="alert" size={17} /> {content}
            </p>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                table: (props) => (
                  <div className="table-wrap">
                    <table {...props} />
                  </div>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
        {charts?.length > 0 && <ChartGallery charts={charts} />}
        <span className="time">{time(createdAt)}</span>
      </div>
    </div>
  );
}
