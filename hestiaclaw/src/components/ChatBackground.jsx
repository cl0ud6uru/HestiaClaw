import { useEffect, useRef } from 'react'
import ForceGraph3D from '3d-force-graph'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import './ChatBackground.css'

const COMMUNITY_COLORS = [
  '#00d4ff', '#00ffaa', '#0099ff', '#7b2fff', '#ff6b35',
  '#ff3366', '#ffcc00', '#00ff88', '#ff00cc', '#33ccff',
  '#ff9900', '#66ff66',
]

function communityColor(community) {
  return COMMUNITY_COLORS[Math.abs(community) % COMMUNITY_COLORS.length]
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
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color: '#8899cc', size: 1.5, transparent: true, opacity: 0.5, sizeAttenuation: true,
  }))
}

function createArcReactor() {
  const group = new THREE.Group()
  const rmat = (emissive, intensity, opacity = 0.92) =>
    new THREE.MeshLambertMaterial({ color: '#ffffff', emissive, emissiveIntensity: intensity, transparent: true, opacity })

  group.add(new THREE.Mesh(new THREE.TorusGeometry(18, 2, 6, 54),   rmat('#00d4ff', 1.4, 0.88)))
  group.add(new THREE.Mesh(new THREE.TorusGeometry(12, 0.9, 6, 36), rmat('#0088ff', 2, 0.9)))

  const turbine = new THREE.Group()
  turbine.add(new THREE.Mesh(new THREE.TorusGeometry(6, 0.6, 6, 24), rmat('#00d4ff', 2.8)))
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 6, 4), rmat('#00aaff', 2.2))
    spoke.rotation.z = -Math.PI / 2 + a
    spoke.position.set(Math.cos(a) * 9, Math.sin(a) * 9, 0)
    turbine.add(spoke)
  }
  group.add(turbine)

  const structure = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 6, 6), rmat('#00d4ff', 1.6, 0.85))
    spoke.rotation.z = -Math.PI / 2 + a
    spoke.position.set(Math.cos(a) * 15, Math.sin(a) * 15, 0)
    structure.add(spoke)
  }
  group.add(structure)

  const core = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 1.2, 32), rmat('#ffffff', 5, 1))
  core.rotation.x = Math.PI / 2
  group.add(core)

  return group
}

const GLOBE_RADIUS = 160

export default function ChatBackground({ pulseAt }) {
  const containerRef = useRef(null)
  const wrapperRef   = useRef(null)
  const graphRef     = useRef(null)
  const reactorRef   = useRef(null)
  const stabilizedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let animActive = true
    stabilizedRef.current = false

    async function init() {
      try {
        const res = await fetch('/api/graph')
        if (!res.ok || cancelled || !containerRef.current) return
        const { nodes: rawNodes, edges: rawEdges } = await res.json()
        if (cancelled || !containerRef.current) return

        const nodes = rawNodes.map(n => ({
          id: n.id, community: n.community, degree: n.degree,
          val: Math.max(1, Math.min(12, n.degree)),
        }))
        const links = rawEdges.map(e => ({ source: e.from, target: e.to }))

        const { offsetWidth: w, offsetHeight: h } = containerRef.current
        const graph = ForceGraph3D()(containerRef.current)
        graphRef.current = graph

        graph
          .backgroundColor('#000000')
          .width(w).height(h)
          .nodeId('id')
          .nodeLabel(() => '')
          .nodeColor(n => communityColor(n.community))
          .nodeThreeObject(node => {
            const r = Math.max(2, Math.min(10, node.degree))
            const color = communityColor(node.community)
            return new THREE.Mesh(
              new THREE.SphereGeometry(r, 10, 7),
              new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 2.5, transparent: true, opacity: 0.85 })
            )
          })
          .nodeThreeObjectExtend(false)
          .linkColor(() => 'rgba(0,180,220,0.06)')
          .linkWidth(0.4)
          .linkOpacity(1)
          .linkDirectionalParticles(0)
          .linkDirectionalArrowLength(0)
          .onEngineStop(() => {
            if (stabilizedRef.current) return
            stabilizedRef.current = true
            graph.cameraPosition({ x: 0, y: 120, z: 820 }, { x: 0, y: 0, z: 0 }, 2000)
            if (wrapperRef.current) wrapperRef.current.classList.add('chat-bg--visible')
          })
          .warmupTicks(400)
          .cooldownTicks(100)
          .d3AlphaDecay(0.03)
          .d3VelocityDecay(0.4)

        graph.d3Force('charge').strength(-15)
        graph.d3Force('link').distance(18)
        graph.d3Force('gravity', alpha => {
          nodes.forEach(n => {
            n.vx -= (n.x || 0) * 0.06 * alpha
            n.vy -= (n.y || 0) * 0.06 * alpha
            if (n.vz !== undefined) n.vz -= (n.z || 0) * 0.06 * alpha
          })
        })
        graph.d3Force('globe', alpha => {
          nodes.forEach(n => {
            const r = Math.hypot(n.x || 0, n.y || 0, n.z || 0) || 1
            const k = alpha * 0.35
            const scale = GLOBE_RADIUS / r - 1
            n.vx = (n.vx || 0) + (n.x || 0) * k * scale
            n.vy = (n.vy || 0) + (n.y || 0) * k * scale
            if (n.vz !== undefined) n.vz += (n.z || 0) * k * scale
          })
        })

        graph.postProcessingComposer().addPass(
          new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.1)
        )

        const stars = createStarField()
        graph.scene().add(stars)

        const reactor = createArcReactor()
        reactorRef.current = reactor
        graph.scene().add(reactor)

        function animLoop() {
          if (!animActive) return
          const now = Date.now()
          const g = reactorRef.current
          if (g) {
            g.rotation.y += 0.004
            g.children[0].rotation.z -= 0.003
            g.children[1].rotation.z += 0.007
            g.children[2].rotation.z += 0.015
            g.children[3].rotation.z -= 0.002
            const core = g.children[4]?.material
            if (core) core.emissiveIntensity = 3.5 + Math.sin(now * 0.003) * 1.5
          }
          if (stabilizedRef.current && graphRef.current) {
            const cam = graphRef.current.cameraPosition()
            const dist = Math.hypot(cam.x, cam.z) || 820
            const angle = Math.atan2(cam.x, cam.z) + 0.0008
            const targetY = Math.sin(now * 0.00004) * 60 + 120
            graphRef.current.cameraPosition({
              x: Math.sin(angle) * dist,
              y: cam.y + (targetY - cam.y) * 0.004,
              z: Math.cos(angle) * dist,
            })
          }
          requestAnimationFrame(animLoop)
        }
        animLoop()

        graph.graphData({ nodes, links })
      } catch { /* background is non-critical */ }
    }

    init()
    return () => {
      cancelled = true
      animActive = false
      if (graphRef.current) {
        graphRef.current.pauseAnimation()
        graphRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!pulseAt || !wrapperRef.current) return
    const el = wrapperRef.current
    el.classList.remove('chat-bg--pulse')
    void el.offsetWidth // force reflow to restart animation
    el.classList.add('chat-bg--pulse')
    const t = setTimeout(() => el.classList.remove('chat-bg--pulse'), 2500)
    return () => clearTimeout(t)
  }, [pulseAt])

  return (
    <div ref={wrapperRef} className="chat-bg">
      <div ref={containerRef} className="chat-bg-canvas" />
    </div>
  )
}
