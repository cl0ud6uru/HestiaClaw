import { useEffect, useRef, useReducer, useState, useCallback } from 'react'
import ForceGraph3D from '3d-force-graph'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import './GraphView.css'

const COMMUNITY_COLORS = [
  '#00d4ff', '#00ffaa', '#0099ff', '#7b2fff', '#ff6b35',
  '#ff3366', '#ffcc00', '#00ff88', '#ff00cc', '#33ccff',
  '#ff9900', '#66ff66',
]

const GOLD_COLORS = [
  '#ffd700', '#ff8c00', '#ffb347', '#ffa500', '#ff6b35',
  '#ffe066', '#ffcc00', '#ffd27f', '#e8a000', '#ffba08',
  '#f4a261', '#e9c46a',
]

const BLOOM_RADIUS    = 0.4
const BLOOM_THRESHOLD = 0.12
const BLOOM_DEFAULT   = 0.3
const BLOOM_MAX       = 1.0
const GLOBE_RADIUS    = 160

function communityColor(community, gold = false) {
  const palette = gold ? GOLD_COLORS : COMMUNITY_COLORS
  return palette[Math.abs(community) % palette.length]
}

function makeTextSprite(text, nodeRadius) {
  const cw = 256, ch = 48
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')

  const label = text.length > 28 ? text.slice(0, 28) + '…' : text
  ctx.font = 'bold 18px Rajdhani, Arial, sans-serif'

  const tw = Math.min(ctx.measureText(label).width, cw - 16)
  const pad = 8, cr = 5
  const bx = (cw - tw - pad * 2) / 2
  const by = (ch - 26) / 2
  const bw = tw + pad * 2, bh = 26

  ctx.fillStyle = 'rgba(3, 8, 16, 0.82)'
  ctx.beginPath()
  ctx.moveTo(bx + cr, by)
  ctx.lineTo(bx + bw - cr, by)
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + cr)
  ctx.lineTo(bx + bw, by + bh - cr)
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - cr, by + bh)
  ctx.lineTo(bx + cr, by + bh)
  ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - cr)
  ctx.lineTo(bx, by + cr)
  ctx.quadraticCurveTo(bx, by, bx + cr, by)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cw / 2, ch / 2)

  const texture = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const h = Math.max(4, nodeRadius * 0.9)
  sprite.scale.set(h * (cw / ch), h, 1)
  sprite.position.set(0, nodeRadius + h / 2 + 1, 0)
  return sprite
}

function createStarField() {
  const count = 2000
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 400 + Math.random() * 400
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.PointsMaterial({
    color: '#8899cc',
    size: 1.5,
    transparent: true,
    opacity: 0.5,
    sizeAttenuation: true,
  })
  return new THREE.Points(geo, mat)
}

function createArcReactor() {
  const group = new THREE.Group()

  const rmat = (emissive, intensity, opacity = 0.92) =>
    new THREE.MeshLambertMaterial({ color: '#ffffff', emissive, emissiveIntensity: intensity, transparent: true, opacity })

  // [0] Outer housing ring — hexagonal cross-section, slow CW
  group.add(new THREE.Mesh(
    new THREE.TorusGeometry(18, 2, 6, 54),
    rmat('#00d4ff', 1.4, 0.88)
  ))

  // [1] Mid ring — counter-rotates CCW
  group.add(new THREE.Mesh(
    new THREE.TorusGeometry(12, 0.9, 6, 36),
    rmat('#0088ff', 2, 0.9)
  ))

  // [2] Turbine group — inner ring + 6 radial spokes, rotates fast CW
  const turbine = new THREE.Group()
  turbine.add(new THREE.Mesh(
    new THREE.TorusGeometry(6, 0.6, 6, 24),
    rmat('#00d4ff', 2.8)
  ))
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    const spoke = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 6, 4),
      rmat('#00aaff', 2.2)
    )
    // rotate cylinder (along Y) to point radially outward at `angle`
    spoke.rotation.z = -Math.PI / 2 + angle
    const midR = (6 + 12) / 2
    spoke.position.set(Math.cos(angle) * midR, Math.sin(angle) * midR, 0)
    turbine.add(spoke)
  }
  group.add(turbine)

  // [3] Structure group — 3 thick spokes from mid ring to outer, very slow
  const structure = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2
    const spoke = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 6, 6),
      rmat('#00d4ff', 1.6, 0.85)
    )
    spoke.rotation.z = -Math.PI / 2 + angle
    const midR = (12 + 18) / 2
    spoke.position.set(Math.cos(angle) * midR, Math.sin(angle) * midR, 0)
    structure.add(spoke)
  }
  group.add(structure)

  // [4] Core disc — flat cylinder, intensely bright, pulses
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 4.5, 1.2, 32),
    rmat('#ffffff', 5, 1)
  )
  core.rotation.x = Math.PI / 2
  group.add(core)

  return group
}

function makeClusterSprite(text, x, y, z, color) {
  const cw = 300, ch = 50
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')

  const cr = 6
  ctx.fillStyle = 'rgba(3, 8, 16, 0.75)'
  ctx.beginPath()
  ctx.moveTo(cr, 0); ctx.lineTo(cw - cr, 0)
  ctx.arcTo(cw, 0, cw, cr, cr); ctx.lineTo(cw, ch - cr)
  ctx.arcTo(cw, ch, cw - cr, ch, cr); ctx.lineTo(cr, ch)
  ctx.arcTo(0, ch, 0, ch - cr, cr); ctx.lineTo(0, cr)
  ctx.arcTo(0, 0, cr, 0, cr)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.55
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.font = 'bold 20px Orbitron, Arial, sans-serif'
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cw / 2, ch / 2)

  const texture = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(38, 6.3, 1)
  sprite.position.set(x, y, z)
  return sprite
}

const UI_INIT = { status: 'loading', error: '', nodeCount: 0, selectedNode: null, stabilized: false, bloomStrength: BLOOM_DEFAULT }

function uiReducer(state, action) {
  switch (action.type) {
    case 'RESET':          return { ...UI_INIT, bloomStrength: state.bloomStrength }
    case 'READY':          return { ...state, status: 'ready', nodeCount: action.nodeCount }
    case 'ERROR':          return { ...state, status: 'error', error: action.error }
    case 'STABILIZED':     return { ...state, stabilized: true }
    case 'SELECT_NODE':    return { ...state, selectedNode: action.node }
    case 'DESELECT':       return { ...state, selectedNode: null }
    case 'BLOOM_STRENGTH': return { ...state, bloomStrength: action.strength }
    default:               return state
  }
}

export default function GraphView({ onClose }) {
  const savedGraphSettings = (() => {
    try { return JSON.parse(localStorage.getItem('hestia-graph-settings') ?? '{}') } catch { return {} }
  })()

  const containerRef      = useRef(null)
  const graphRef          = useRef(null)
  const bloomRef          = useRef(null)
  const rawDataRef        = useRef({ nodes: [], edges: [] })
  const showLabelsRef     = useRef(savedGraphSettings.showLabels ?? false)
  const nodesRef          = useRef([])
  const nodeMaterialsRef  = useRef(new Map())
  const isGoldRef         = useRef(savedGraphSettings.isGold ?? false)
  const isGlobeRef        = useRef(savedGraphSettings.isGlobe ?? true)
  const showClustersRef   = useRef(savedGraphSettings.showClusters ?? false)
  const clusterSpritesRef = useRef([])
  const arcReactorRef      = useRef(null)
  const starFieldRef       = useRef(null)
  const communityNamesRef  = useRef(new Map())
  const isAnimatingRef      = useRef(savedGraphSettings.isAnimating ?? true)
  const orbitPausedUntilRef = useRef(0)
  const showStarsRef        = useRef(savedGraphSettings.showStars ?? false)
  const hasStabilizedRef    = useRef(false)

  const [ui, dispatch]              = useReducer(uiReducer, { ...UI_INIT, bloomStrength: savedGraphSettings.bloomStrength ?? BLOOM_DEFAULT })
  const [refreshKey, setRefreshKey] = useState(0)
  const [recomputing, setRecomputing]   = useState(false)
  const [recomputeMsg, setRecomputeMsg] = useState('')
  const [showLabels, setShowLabels]     = useState(savedGraphSettings.showLabels ?? false)
  const [is3D, setIs3D]                 = useState(savedGraphSettings.is3D ?? true)
  const [isGlobe, setIsGlobe]           = useState(savedGraphSettings.isGlobe ?? true)
  const [isGold, setIsGold]             = useState(savedGraphSettings.isGold ?? false)
  const [showClusters, setShowClusters] = useState(savedGraphSettings.showClusters ?? false)
  const [showReactor, setShowReactor]   = useState(savedGraphSettings.showReactor ?? true)
  const [showStars, setShowStars]       = useState(savedGraphSettings.showStars ?? false)
  const [communities, setCommunities]   = useState([])
  const [edgeCount, setEdgeCount]       = useState(0)
  const [isAnimating, setIsAnimating]   = useState(savedGraphSettings.isAnimating ?? true)

  // Persist graph display settings to localStorage
  useEffect(() => {
    localStorage.setItem('hestia-graph-settings', JSON.stringify({
      showLabels, is3D, isGlobe, isGold, showClusters, showReactor, showStars, isAnimating,
      bloomStrength: ui.bloomStrength,
    }))
  }, [showLabels, is3D, isGlobe, isGold, showClusters, showReactor, showStars, isAnimating, ui.bloomStrength])

  // Keep canvas sized to its container
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      graphRef.current?.width(Math.floor(width)).height(Math.floor(height))
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const handleNodeClick = useCallback(node => {
    const { nodes: rn, edges: re } = rawDataRef.current
    const rawNode = rn.find(n => n.id === node.id)
    if (!rawNode) return

    const relationships = re
      .filter(e => e.from === node.id || e.to === node.id)
      .map(e => {
        const isFrom = e.from === node.id
        const otherId = isFrom ? e.to : e.from
        const other = rn.find(n => n.id === otherId)
        return {
          direction: isFrom ? 'out' : 'in',
          targetLabel: other?.label || '?',
          fact: e.label || '',
        }
      })
      .sort((a, b) => a.targetLabel.localeCompare(b.targetLabel))

    dispatch({
      type: 'SELECT_NODE',
      node: {
        label: rawNode.label,
        degree: rawNode.degree,
        community: rawNode.community,
        color: communityColor(rawNode.community, isGoldRef.current),
        relationships,
      },
    })

    const { x = 0, y = 0, z = 0 } = node
    const dist = 100
    const ratio = 1 + dist / (Math.hypot(x, y, z) || 1)
    orbitPausedUntilRef.current = Date.now() + 2500
    graphRef.current?.cameraPosition(
      { x: x * ratio, y: y * ratio, z: z * ratio },
      { x, y, z },
      1000
    )
  }, [])

  const handleToggleLabels = useCallback(() => {
    showLabelsRef.current = !showLabelsRef.current
    setShowLabels(showLabelsRef.current)
    graphRef.current?.refresh()
  }, [])

  const handleToggle3D = useCallback(() => {
    setIs3D(prev => {
      const next = !prev
      if (graphRef.current) {
        graphRef.current.numDimensions(next ? 3 : 2)
        graphRef.current.d3ReheatSimulation()
      }
      return next
    })
  }, [])

  const handleBloomChange = useCallback(e => {
    const strength = parseFloat(e.target.value)
    if (bloomRef.current) bloomRef.current.strength = strength
    dispatch({ type: 'BLOOM_STRENGTH', strength })
  }, [])

  const handleToggleGlobe = useCallback(() => {
    setIsGlobe(prev => {
      const next = !prev
      isGlobeRef.current = next
      if (!graphRef.current) return next
      if (next) {
        graphRef.current.d3Force('globe', alpha => {
          nodesRef.current.forEach(node => {
            const r = Math.hypot(node.x || 0, node.y || 0, node.z || 0) || 1
            const k = alpha * 0.35
            const scale = GLOBE_RADIUS / r - 1
            node.vx = (node.vx || 0) + (node.x || 0) * k * scale
            node.vy = (node.vy || 0) + (node.y || 0) * k * scale
            if (node.vz !== undefined) node.vz += (node.z || 0) * k * scale
          })
        })
      } else {
        graphRef.current.d3Force('globe', null)
      }
      graphRef.current.d3ReheatSimulation()
      return next
    })
  }, [])

  const handleToggleReactor = useCallback(() => {
    setShowReactor(prev => {
      const next = !prev
      if (arcReactorRef.current) arcReactorRef.current.visible = next
      return next
    })
  }, [])

  const handleToggleStars = useCallback(() => {
    setShowStars(prev => {
      const next = !prev
      showStarsRef.current = next
      if (starFieldRef.current) starFieldRef.current.visible = next
      return next
    })
  }, [])

  const handleToggleAnimate = useCallback(() => {
    setIsAnimating(prev => {
      const next = !prev
      isAnimatingRef.current = next
      return next
    })
  }, [])

  const handleCommunityClick = useCallback(communityId => {
    const commNodes = nodesRef.current.filter(n => n.community === communityId)
    if (!commNodes.length || !graphRef.current) return
    const cx = commNodes.reduce((s, n) => s + (n.x || 0), 0) / commNodes.length
    const cy = commNodes.reduce((s, n) => s + (n.y || 0), 0) / commNodes.length
    const cz = commNodes.reduce((s, n) => s + (n.z || 0), 0) / commNodes.length
    const dist = 90
    const r = Math.hypot(cx, cy, cz) || 1
    graphRef.current.cameraPosition(
      { x: cx + (cx / r) * dist, y: cy + (cy / r) * dist, z: cz + (cz / r) * dist },
      { x: cx, y: cy, z: cz },
      800
    )
  }, [])

  const handleToggleGold = useCallback(() => {
    setIsGold(prev => {
      const next = !prev
      isGoldRef.current = next
      nodesRef.current.forEach(node => {
        const mat = nodeMaterialsRef.current.get(node.id)
        if (!mat) return
        const color = communityColor(node.community, next)
        mat.color.set(color)
        mat.emissive.set(color)
      })
      if (graphRef.current) {
        graphRef.current.linkDirectionalParticleColor(link => {
          const id = link.source?.id ?? link.source
          const node = nodesRef.current.find(n => n.id === id)
          return communityColor(node?.community ?? 0, next)
        })
      }
      return next
    })
  }, [])

  const updateClusterLabels = useCallback(() => {
    if (!graphRef.current) return
    const scene = graphRef.current.scene()
    if (!scene) return

    clusterSpritesRef.current.forEach(s => scene.remove(s))
    clusterSpritesRef.current = []

    if (!showClustersRef.current) return

    const byComm = new Map()
    nodesRef.current.forEach(n => {
      if (!byComm.has(n.community)) byComm.set(n.community, [])
      byComm.get(n.community).push(n)
    })

    byComm.forEach((commNodes, community) => {
      if (commNodes.length < 2) return
      const cx = commNodes.reduce((s, n) => s + (n.x || 0), 0) / commNodes.length
      const cy = commNodes.reduce((s, n) => s + (n.y || 0), 0) / commNodes.length
      const cz = commNodes.reduce((s, n) => s + (n.z || 0), 0) / commNodes.length
      const color = communityColor(community, isGoldRef.current)
      const name = communityNamesRef.current.get(community) || `GROUP ${community}`
      const sprite = makeClusterSprite(name, cx, cy + 35, cz, color)
      scene.add(sprite)
      clusterSpritesRef.current.push(sprite)
    })
  }, [])

  const handleToggleClusters = useCallback(() => {
    setShowClusters(prev => {
      const next = !prev
      showClustersRef.current = next
      updateClusterLabels()
      return next
    })
  }, [updateClusterLabels])

  useEffect(() => {
    let cancelled = false
    let animActive = true
    dispatch({ type: 'RESET' })

    hasStabilizedRef.current = false
    if (graphRef.current) {
      graphRef.current.pauseAnimation()
      graphRef.current = null
    }
    bloomRef.current = null
    nodeMaterialsRef.current.clear()

    async function init() {
      try {
        const res = await fetch('/api/graph')
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const { nodes: rawNodes, edges: rawEdges } = await res.json()
        if (cancelled || !containerRef.current) return

        rawDataRef.current = { nodes: rawNodes, edges: rawEdges }
        dispatch({ type: 'READY', nodeCount: rawNodes.length })

        // Build community list — name each group after its highest-degree node
        const byComm = new Map()
        rawNodes.forEach(n => {
          if (!byComm.has(n.community)) byComm.set(n.community, { count: 0, topNode: n })
          const c = byComm.get(n.community)
          c.count++
          if ((n.degree || 0) > (c.topNode.degree || 0)) c.topNode = n
        })
        const namesMap = new Map()
        const commList = Array.from(byComm.entries()).map(([id, { count, topNode }]) => {
          const name = topNode.label || `GROUP ${id}`
          namesMap.set(id, name)
          return { id, count, name }
        })
        communityNamesRef.current = namesMap
        setCommunities(commList.sort((a, b) => b.count - a.count))
        setEdgeCount(rawEdges.length)

        const nodes = rawNodes.map(n => ({
          id: n.id,
          label: n.label,
          community: n.community,
          degree: n.degree,
          color: communityColor(n.community, isGoldRef.current),
          val: Math.max(1, Math.min(20, n.degree)),
        }))
        nodesRef.current = nodes

        const links = rawEdges.map(e => ({
          source: e.from,
          target: e.to,
          label: e.label,
        }))

        const { offsetWidth: w, offsetHeight: h } = containerRef.current

        const graph = ForceGraph3D()(containerRef.current)
        graphRef.current = graph

        graph
          .backgroundColor('#000000')
          .width(w)
          .height(h)
          .nodeId('id')
          .nodeLabel('label')
          .nodeColor(n => communityColor(n.community, isGoldRef.current))
          .nodeThreeObject(node => {
            const r = Math.max(3, Math.min(14, node.degree * 1.2))
            const group = new THREE.Group()
            const color = communityColor(node.community, isGoldRef.current)
            const geo = new THREE.SphereGeometry(r, 16, 12)
            const mat = new THREE.MeshLambertMaterial({
              color,
              emissive: color,
              emissiveIntensity: 1.4,
              transparent: true,
              opacity: 0.92,
            })
            nodeMaterialsRef.current.set(node.id, mat)
            group.add(new THREE.Mesh(geo, mat))
            if (showLabelsRef.current) group.add(makeTextSprite(node.label, r))
            return group
          })
          .nodeThreeObjectExtend(false)
          .linkColor(() => 'rgba(0,180,220,0.25)')
          .linkWidth(1.2)
          .linkOpacity(1)
          .linkDirectionalArrowLength(4)
          .linkDirectionalArrowRelPos(1)
          .linkDirectionalParticles(4)
          .linkDirectionalParticleSpeed(0.007)
          .linkDirectionalParticleWidth(2.5)
          .linkDirectionalParticleColor(link => {
            const id = link.source?.id ?? link.source
            const n = nodes.find(n => n.id === id)
            return communityColor(n?.community ?? 0, isGoldRef.current)
          })
          .onNodeClick(handleNodeClick)
          .onBackgroundClick(() => dispatch({ type: 'DESELECT' }))
          .onEngineStop(() => {
            if (hasStabilizedRef.current) return
            hasStabilizedRef.current = true
            graphRef.current?.zoomToFit(600, 20)
            dispatch({ type: 'STABILIZED' })
            updateClusterLabels()
          })
          .warmupTicks(300)
          .cooldownTicks(200)
          .d3AlphaDecay(0.02)
          .d3VelocityDecay(0.3)

        graph.d3Force('charge').strength(-20)
        graph.d3Force('link').distance(20)

        // Gravity well — pulls every node toward origin so isolated
        // communities don't drift to opposite corners of space
        graph.d3Force('gravity', alpha => {
          nodes.forEach(node => {
            node.vx -= (node.x || 0) * 0.06 * alpha
            node.vy -= (node.y || 0) * 0.06 * alpha
            if (node.vz !== undefined) node.vz -= (node.z || 0) * 0.06 * alpha
          })
        })

        if (isGlobeRef.current) {
          graph.d3Force('globe', alpha => {
            nodes.forEach(node => {
              const r = Math.hypot(node.x || 0, node.y || 0, node.z || 0) || 1
              const k = alpha * 0.35
              const scale = GLOBE_RADIUS / r - 1
              node.vx = (node.vx || 0) + (node.x || 0) * k * scale
              node.vy = (node.vy || 0) + (node.y || 0) * k * scale
              if (node.vz !== undefined) node.vz += (node.z || 0) * k * scale
            })
          })
        }

        const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM_DEFAULT, BLOOM_RADIUS, BLOOM_THRESHOLD)
        bloomRef.current = bloom
        graph.postProcessingComposer().addPass(bloom)

        // Starfield — respects current toggle state on refresh
        const stars = createStarField()
        stars.visible = showStarsRef.current
        starFieldRef.current = stars
        graph.scene().add(stars)

        // Arc reactor at origin
        const reactor = createArcReactor()
        arcReactorRef.current = reactor
        graph.scene().add(reactor)

        // Combined animation loop
        // Reactor children: [0]=outerRing [1]=midRing [2]=turbine [3]=structure [4]=core
        function animLoop() {
          if (!animActive) return
          const now = Date.now()

          // Arc reactor rings + pulsing core
          const g = arcReactorRef.current
          if (g) {
            g.rotation.y += 0.004
            g.children[0].rotation.z -= 0.003
            g.children[1].rotation.z += 0.007
            g.children[2].rotation.z += 0.015
            g.children[3].rotation.z -= 0.002
            const coreMat = g.children[4]?.material
            if (coreMat) coreMat.emissiveIntensity = 3.5 + Math.sin(now * 0.003) * 1.5
          }

          // Camera orbit + slow inclination drift
          if (isAnimatingRef.current && graphRef.current && now > orbitPausedUntilRef.current) {
            const cam = graphRef.current.cameraPosition()
            const dist = Math.hypot(cam.x, cam.z) || 280
            const angle = Math.atan2(cam.x, cam.z) + 0.002
            const targetY = Math.sin(now * 0.00006) * 80
            const newY = cam.y + (targetY - cam.y) * 0.008
            graphRef.current.cameraPosition({
              x: Math.sin(angle) * dist,
              y: newY,
              z: Math.cos(angle) * dist,
            })
          }

          requestAnimationFrame(animLoop)
        }
        animLoop()

        graph.graphData({ nodes, links })
      } catch (err) {
        if (!cancelled) dispatch({ type: 'ERROR', error: err.message || 'Unknown error' })
      }
    }

    init()
    return () => {
      cancelled = true
      animActive = false
      if (graphRef.current) {
        const scene = graphRef.current.scene()
        if (scene) {
          if (starFieldRef.current) scene.remove(starFieldRef.current)
          if (arcReactorRef.current) scene.remove(arcReactorRef.current)
          clusterSpritesRef.current.forEach(s => scene.remove(s))
        }
        graphRef.current.pauseAnimation()
        graphRef.current = null
      }
      clusterSpritesRef.current = []
    }
  }, [refreshKey, handleNodeClick, updateClusterLabels])

  const { status, error, nodeCount, selectedNode, stabilized, bloomStrength } = ui

  return (
    <div className="graph-overlay" role="dialog" aria-modal="true">
      <div className="graph-panel">
        <span className="bubble-corner tl" aria-hidden />
        <span className="bubble-corner tr" aria-hidden />
        <span className="bubble-corner bl" aria-hidden />
        <span className="bubble-corner br" aria-hidden />

        <div className="graph-header">
          <span className="graph-title">KNOWLEDGE GRAPH</span>
          {status === 'ready' && (
            <span className="graph-count">{nodeCount} NODES</span>
          )}
          {status === 'ready' && (
            <>
              <button
                className="graph-recompute"
                disabled={recomputing}
                onClick={async () => {
                  setRecomputing(true)
                  setRecomputeMsg('')
                  try {
                    const res = await fetch('/api/graph/recompute', { method: 'POST' })
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
                    setRecomputeMsg('DONE')
                    setTimeout(() => {
                      setRecomputeMsg('')
                      setRefreshKey(k => k + 1)
                    }, 1200)
                  } catch (err) {
                    setRecomputeMsg(err.message || 'FAILED')
                    setTimeout(() => setRecomputeMsg(''), 4000)
                  } finally {
                    setRecomputing(false)
                  }
                }}
                title="Recompute community colors and node sizes via GDS"
                aria-label="Recompute GDS analytics"
              >
                {recomputing ? 'COMPUTING...' : 'RECOMPUTE'}
              </button>
              {recomputeMsg && (
                <span className={`graph-recompute-msg ${recomputeMsg === 'DONE' ? 'graph-recompute-ok' : 'graph-recompute-err'}`}>
                  {recomputeMsg}
                </span>
              )}
              <button
                className="graph-refresh"
                onClick={() => setRefreshKey(k => k + 1)}
                title="Refresh graph data"
                aria-label="Refresh knowledge graph"
              >
                ↺
              </button>
            </>
          )}
          <button className="graph-close" onClick={onClose} aria-label="Close knowledge graph">✕</button>
        </div>

        {status === 'ready' && (
          <div className="graph-controls">
            <button
              className={`graph-ctrl-btn${showLabels ? ' active' : ''}`}
              onClick={handleToggleLabels}
              title="Toggle node labels"
            >
              LABELS
            </button>
            <button
              className={`graph-ctrl-btn${!is3D ? ' active' : ''}`}
              onClick={handleToggle3D}
              title="Toggle 2D / 3D layout"
            >
              {is3D ? '3D → 2D' : '2D → 3D'}
            </button>
            <button
              className={`graph-ctrl-btn${isGlobe ? ' active' : ''}`}
              onClick={handleToggleGlobe}
              title="Spherical layout — pulls nodes onto a globe surface"
            >
              GLOBE
            </button>
            <button
              className={`graph-ctrl-btn${isAnimating ? ' active' : ''}`}
              onClick={handleToggleAnimate}
              title="Orbit camera slowly around the graph"
            >
              ORBIT
            </button>
            <button
              className={`graph-ctrl-btn graph-ctrl-btn--gold${isGold ? ' active' : ''}`}
              onClick={handleToggleGold}
              title="Gold/amber Hestia palette"
            >
              GOLD
            </button>
            <button
              className={`graph-ctrl-btn${showClusters ? ' active' : ''}`}
              onClick={handleToggleClusters}
              title="Toggle community cluster labels"
            >
              CLUSTERS
            </button>
            <button
              className={`graph-ctrl-btn${showReactor ? ' active' : ''}`}
              onClick={handleToggleReactor}
              title="Toggle arc reactor core"
            >
              CORE
            </button>
            <button
              className={`graph-ctrl-btn${showStars ? ' active' : ''}`}
              onClick={handleToggleStars}
              title="Toggle starfield background"
            >
              STARS
            </button>
            <span className="graph-ctrl-label">BLOOM</span>
            <input
              type="range"
              className="graph-ctrl-slider"
              min={0}
              max={BLOOM_MAX}
              step={0.05}
              value={bloomStrength}
              onChange={handleBloomChange}
              style={{ '--bloom-pct': `${(bloomStrength / BLOOM_MAX) * 100}%` }}
              title={`Bloom intensity: ${Math.round((bloomStrength / BLOOM_MAX) * 100)}%`}
            />
          </div>
        )}

        {status === 'loading' && (
          <div className="graph-status">
            <span className="graph-loading">CONNECTING TO KNOWLEDGE GRAPH...</span>
          </div>
        )}

        {status === 'error' && (
          <div className="graph-status">
            <span className="graph-error">KNOWLEDGE GRAPH UNAVAILABLE</span>
            <span className="graph-error-detail">{error}</span>
          </div>
        )}

        <div className="graph-body" style={{ display: status === 'error' ? 'none' : undefined }}>
          <div
            ref={containerRef}
            className="graph-canvas"
            style={{ opacity: stabilized ? 1 : 0, transition: 'opacity 0.7s ease' }}
          />

          {status === 'ready' && communities.length > 0 && (
            <div className="graph-layers-panel">
              <div className="graph-layers-title">HESTIA LAYERS</div>
              <div className="graph-layers-list">
                {communities.map(c => (
                  <button
                    key={c.id}
                    className="graph-layer-row"
                    onClick={() => handleCommunityClick(c.id)}
                    title={`Focus on group ${c.id}`}
                  >
                    <span
                      className="graph-layer-dot"
                      style={{ background: communityColor(c.id, isGold) }}
                    />
                    <span className="graph-layer-label">{c.name}</span>
                    <span className="graph-layer-count">{c.count}</span>
                  </button>
                ))}
              </div>
              <div className="graph-layers-stats">
                <div className="graph-stat-row">
                  <span className="graph-stat-key">NODES</span>
                  <span className="graph-stat-val">{nodeCount}</span>
                </div>
                <div className="graph-stat-row">
                  <span className="graph-stat-key">EDGES</span>
                  <span className="graph-stat-val">{edgeCount}</span>
                </div>
                <div className="graph-stat-row">
                  <span className="graph-stat-key">GROUPS</span>
                  <span className="graph-stat-val">{communities.length}</span>
                </div>
              </div>
            </div>
          )}

          {selectedNode && (
            <div className="graph-info-panel">
              <div className="graph-info-header">
                <span className="graph-info-dot" style={{ background: selectedNode.color }} />
                <span className="graph-info-name">{selectedNode.label}</span>
                <button
                  className="graph-info-dismiss"
                  onClick={() => dispatch({ type: 'DESELECT' })}
                  aria-label="Dismiss"
                >✕</button>
              </div>
              <div className="graph-info-meta">
                {selectedNode.degree} CONNECTION{selectedNode.degree !== 1 ? 'S' : ''}
                &nbsp;·&nbsp;
                COMMUNITY {selectedNode.community}
              </div>
              <div className="graph-info-relations">
                {selectedNode.relationships.length === 0 && (
                  <div className="graph-info-empty">No relationships found</div>
                )}
                {selectedNode.relationships.map((r, i) => (
                  <div key={i} className="graph-info-relation">
                    <span className="graph-info-arrow">{r.direction === 'out' ? '→' : '←'}</span>
                    {' '}
                    <span className="graph-info-target">{r.targetLabel}</span>
                    {r.fact && <span className="graph-info-fact">{r.fact}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
