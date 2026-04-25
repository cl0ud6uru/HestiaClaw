import './ThinkingAnimation.css'

export default function ThinkingAnimation({ activeTool }) {
  return (
    <div className="thinking-wrapper">
      <div className="thinking-avatar">
        <span>J</span>
      </div>
      <div className="thinking-hud">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />

        <div className="arc-reactor">
          <div className="ring r1" />
          <div className="ring r2" />
          <div className="ring r3" />
          <div className="ring r4" />
          <div className="hex-grid">
            <div className="hex h1" />
            <div className="hex h2" />
            <div className="hex h3" />
          </div>
          <div className="core">
            <div className="core-glow" />
            <div className="core-dot" />
          </div>
          <div className="scan-line" />
        </div>

        <div className="processing-label">
          <span className="label-text">PROCESSING</span>
          <div className="dots">
            <span /><span /><span />
          </div>
        </div>

        <div className={`tool-status ${activeTool ? 'tool-status--active' : ''}`}>
          <span className="tool-status-label">QUERYING:</span>
          <span className="tool-status-name">{activeTool ? activeTool.toUpperCase() : ''}</span>
        </div>

        <div className="data-bars">
          <span /><span /><span /><span /><span />
        </div>
      </div>
    </div>
  )
}
