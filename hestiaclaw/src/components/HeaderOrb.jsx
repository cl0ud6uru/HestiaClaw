import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import './HeaderOrb.css'

const COMMUNITY_COLORS = [
  '#00d4ff', '#00ffaa', '#0099ff', '#7b2fff', '#ff6b35',
  '#ff3366', '#ffcc00', '#00ff88', '#ff00cc', '#33ccff',
  '#ff9900', '#66ff66',
]

function buildScene() {
  const scene = new THREE.Scene()

  // Ambient light so emissive materials render correctly
  scene.add(new THREE.AmbientLight(0xffffff, 0.2))

  // Starfield — small sphere shell
  const count = 800
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 90 + Math.random() * 80
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    pos[i * 3 + 2] = r * Math.cos(phi)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: '#8899cc', size: 0.8, transparent: true, opacity: 0.55, sizeAttenuation: true,
  })))

  // Synthetic nodes — Fibonacci sphere distribution
  const nodeCount = 28
  const goldenRatio = (1 + Math.sqrt(5)) / 2
  const nodeObjs = []
  for (let i = 0; i < nodeCount; i++) {
    const theta = Math.acos(1 - 2 * (i + 0.5) / nodeCount)
    const phi = 2 * Math.PI * i / goldenRatio
    const r = 32
    const color = COMMUNITY_COLORS[i % COMMUNITY_COLORS.length]
    const size = 1.2 + (i % 4) * 0.6
    const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 3.5 })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), mat)
    mesh.position.set(
      r * Math.sin(theta) * Math.cos(phi),
      r * Math.sin(theta) * Math.sin(phi),
      r * Math.cos(theta),
    )
    scene.add(mesh)
    nodeObjs.push(mesh)
  }

  // Edges — connect nearby nodes with faint lines
  const lineMat = new THREE.LineBasicMaterial({ color: '#003355', transparent: true, opacity: 0.35 })
  for (let i = 0; i < nodeObjs.length; i++) {
    for (let j = i + 1; j < nodeObjs.length; j++) {
      if (nodeObjs[i].position.distanceTo(nodeObjs[j].position) < 22) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          nodeObjs[i].position.clone(),
          nodeObjs[j].position.clone(),
        ])
        scene.add(new THREE.Line(geo, lineMat))
      }
    }
  }

  // Simplified arc reactor at origin
  const rmat = (emissive, intensity) =>
    new THREE.MeshLambertMaterial({ color: '#ffffff', emissive, emissiveIntensity: intensity, transparent: true, opacity: 0.9 })
  const reactor = new THREE.Group()
  reactor.add(new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.5, 6, 32), rmat('#00d4ff', 2)))
  reactor.add(new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.3, 6, 20), rmat('#0088ff', 3)))
  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.3, 16), rmat('#ffffff', 6))
  core.rotation.x = Math.PI / 2
  reactor.add(core)
  scene.add(reactor)

  return { scene, reactor, core }
}

export default function HeaderOrb({ pulseAt }) {
  const canvasRef = useRef(null)
  const orbRef    = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const SIZE = 100
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setPixelRatio(dpr)
    renderer.setSize(SIZE, SIZE)
    renderer.setClearColor(0x000000, 0)

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
    camera.position.set(0, 20, 185)
    camera.lookAt(0, 0, 0)

    const { scene, reactor } = buildScene()
    let active = true
    let angle = 0

    function tick() {
      if (!active) return
      const now = Date.now()
      angle += 0.008
      camera.position.x = Math.sin(angle) * 185
      camera.position.z = Math.cos(angle) * 185
      camera.position.y = Math.sin(now * 0.0003) * 20 + 18
      camera.lookAt(0, 0, 0)

      reactor.rotation.y += 0.006
      reactor.children[0].rotation.z -= 0.004
      reactor.children[1].rotation.z += 0.010
      const core = reactor.children[2]?.material
      if (core) core.emissiveIntensity = 5 + Math.sin(now * 0.004) * 2

      renderer.render(scene, camera)
      requestAnimationFrame(tick)
    }
    tick()

    return () => {
      active = false
      renderer.dispose()
    }
  }, [])

  useEffect(() => {
    if (!pulseAt || !orbRef.current) return
    const el = orbRef.current
    el.classList.remove('header-orb--pulse')
    void el.offsetWidth
    el.classList.add('header-orb--pulse')
    const t = setTimeout(() => el.classList.remove('header-orb--pulse'), 1500)
    return () => clearTimeout(t)
  }, [pulseAt])

  return (
    <div ref={orbRef} className="header-orb">
      <canvas ref={canvasRef} width={100} height={100} />
    </div>
  )
}
