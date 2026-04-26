import { useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import './ChatMessage.css'

function PreBlock({ children }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef(null)

  const codeChild = Array.isArray(children)
    ? children.find(c => c?.type === 'code')
    : children?.type === 'code' ? children : null
  const lang = /language-(\w+)/.exec(codeChild?.props?.className || '')?.[1]
  const codeText = codeChild ? String(codeChild.props.children).replace(/\n$/, '') : ''

  const handleCopy = () => {
    const text = lang ? codeText : (preRef.current?.textContent || '')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {lang && <span className="code-lang">{lang.toUpperCase()}</span>}
        <button className="code-copy-btn" onClick={handleCopy}>
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      {lang ? (
        <SyntaxHighlighter
          language={lang}
          style={atomDark}
          customStyle={{ background: 'rgba(0,4,18,0.9)', margin: 0, borderRadius: 0, fontSize: '0.82rem', border: 'none' }}
          PreTag="div"
        >
          {codeText}
        </SyntaxHighlighter>
      ) : (
        <pre ref={preRef}>{children}</pre>
      )}
    </div>
  )
}

// Matches lines that look like code: PS variables/cmdlets, common language keywords, CLI tools
const CODE_LINE_RE = /^(\$[A-Za-z_]|[A-Z][a-z]+-[A-Z]|function[\s({]|class[\s{]|import[\s"'`]|from[\s"'`]|const\s|let\s|var\s|def\s|return[\s;({]|if\s*[({]|for\s*[({]|while\s*[({]|switch\s*[({]|try\s*[{]|catch\s*[({]|npm\s|pip\s|git\s|docker\s|python\s|node\s|#!|<\?|<\/|SELECT\s|UPDATE\s|INSERT\s|DELETE\s|CREATE\s|ALTER\s)/

function isCodeLine(line) {
  return CODE_LINE_RE.test(line.trim())
}

function preprocessMarkdown(text) {
  if (text.includes('```')) return text  // already fenced, leave as-is

  const lines = text.split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    if (isCodeLine(lines[i])) {
      const block = []
      // Collect consecutive code lines; allow a single blank line within a block
      // if the next non-blank line is also code
      while (i < lines.length) {
        if (isCodeLine(lines[i])) {
          block.push(lines[i])
          i++
        } else if (lines[i].trim() === '' && i + 1 < lines.length && isCodeLine(lines[i + 1])) {
          block.push(lines[i])
          i++
        } else {
          break
        }
      }
      // Trim trailing blank lines from the block
      while (block.length && block[block.length - 1].trim() === '') block.pop()
      if (block.length) out.push('```', ...block, '```')
    } else {
      out.push(lines[i])
      i++
    }
  }

  return out.join('\n')
}

export default function ChatMessage({ message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`msg-row ${isUser ? 'msg-row--user' : 'msg-row--assistant'}`}>
      {!isUser && (
        <div className="msg-avatar">
          <span>H</span>
        </div>
      )}

      <div className={`msg-bubble ${isUser ? 'msg-bubble--user' : 'msg-bubble--assistant'} ${message.isError ? 'msg-bubble--error' : ''}`}>
        <span className="bubble-corner tl" />
        <span className="bubble-corner tr" />
        <span className="bubble-corner bl" />
        <span className="bubble-corner br" />

        <div className="msg-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: PreBlock }}>
            {preprocessMarkdown(message.content)}
          </ReactMarkdown>
          {message.streaming && <span className="cursor" />}
        </div>

        {message.toolCalls?.length > 0 && (
          <div className="tool-calls">
            {message.toolCalls.map((tc, i) => (
              <span key={i} className={`tool-badge tool-badge--${tc.type}`}>
                {tc.name.toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {isUser && (
        <div className="msg-avatar msg-avatar--user">
          <span>U</span>
        </div>
      )}
    </div>
  )
}
