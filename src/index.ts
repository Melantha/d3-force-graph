import * as THREE from 'three'
import * as v3 from 'v3js'
import nodesVS from './shaders/nodes.vs'
import nodesFS from './shaders/nodes.fs'
import linesVS from './shaders/lines.vs'
import linesFS from './shaders/lines.fs'
import arrowsVS from './shaders/arrows.vs'
import arrowsFS from './shaders/arrows.fs'
import imageVS from './shaders/image.vs'
import imageFS from './shaders/image.fs'
import hlNodesVS from './shaders/hlNodes.vs'
import hlNodesFS from './shaders/hlNodes.fs'
import hlLinesVS from './shaders/hlLines.vs'
import hlLinesFS from './shaders/hlLines.fs'
import worker from 'raw-loader!./worker.js'

window.THREE = THREE
require('three/examples/js/controls/MapControls.js')

type RGBA = [number, number, number, number]

interface GraphData {
  nodes: Array<{
    id: string
    name?: string,
    scale?: number,
    image?: string
  }>,
  links: Array<{
    source: string,
    target: string,
    color?: RGBA
  }>
}

interface GraphBaseConfig {
  width: number,
  height: number,
  nodeSize?: number,
  lineWidth?: number,
  showArrow?: boolean,
  highLightColor?: RGBA,
  showStatTable?: boolean,
  showHUD?: boolean,
  roundedImage?: boolean
}

interface D3ForceData {
  nodes: Array<{
    id: string
  }>,
  links: Array<D3Link>
}

interface D3Link {
  source: string,
  target: string
}

interface ProcessedData extends D3ForceData {
  nodeInfoMap: {
    [key: string]: {
      index: number,
      scale?: number,
      image?: string,
      name?: string,
      imageTexture?: THREE.Texture,
      imagePoint?: ShaderMesh
    }
  },
  linkInfoMap: {
    [key: string]: {
      color?: RGBA
    }
  },
  linkBuffer: Int32Array,
  statTable: Array<{
    source: string,
    count: number
  }>
}

interface Mesh {
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  mesh: THREE.Mesh | THREE.Points | THREE.LineSegments
}

interface ShaderMesh extends Mesh {
  material: THREE.ShaderMaterial,
  positions: Float32Array,
  scale?: Float32Array,
  rotates?: Float32Array,
  colors?: Float32Array
}

interface GraphPerfInfo {
  nodeCounts: number,
  linkCounts: number,
  layoutPastTime: number,
  layoutProgress: string,
  layoutStartTime: number,
  prevTickTime: number,
  targetTick: number,
  intervalTime: number,
  layouting: boolean
}

interface MouseStatus {
  mouseOnTable: boolean,
  mouseOnChart: boolean,
  mousePosition: THREE.Vector2
}

interface ViewportRect {
  left: number,
  right: number,
  top: number,
  bottom: number
}

interface VisibleNode {
  id: string,
  x: number,
  y: number
}

const GRAPH_BASE_CONFIG: GraphBaseConfig = {
  width: 400,
  height: 400,
  nodeSize: 20,
  lineWidth: 1,
  showArrow: true,
  highLightColor: [255, 0, 0, 0.6],
  showStatTable: true,
  showHUD: true,
  roundedImage: true
}

const GRAPH_DEFAULT_PERF_INFO: GraphPerfInfo = {
  nodeCounts: 0,
  linkCounts: 0,
  layoutPastTime: 0,
  layoutProgress: '',
  layoutStartTime: 0,
  prevTickTime: 0,
  targetTick: 0,
  intervalTime: 0,
  layouting: false
}

const textureLoader: THREE.TextureLoader = new THREE.TextureLoader()
const ARROW_TEXTURE = textureLoader.load('../assets/arrow.png')
const NODE_TEXTURE = textureLoader.load('../assets/node.png')

export default class D3ForceGraph {

  $container: HTMLElement
  containerRect: ClientRect
  data: GraphData
  config: GraphBaseConfig
  perfInfo: GraphPerfInfo
  processedData: ProcessedData
  worker: Worker
  targetPositionStatus: Float32Array
  currentPositionStatus: Float32Array
  cachePositionStatus: Float32Array
  mouseStatus: MouseStatus = {
    mouseOnTable: false,
    mouseOnChart: false,
    mousePosition: new THREE.Vector2(-9999, -9999)
  }
  rafId: number
  highlighted: string
  throttleTimer: number

  scene: THREE.Scene
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  controls: any

  nodes: ShaderMesh = {
    geometry: null,
    positions: null,
    scale: null,
    material: null,
    mesh: null
  }
  lines: ShaderMesh = {
    geometry: null,
    positions: null,
    colors: null,
    material: null,
    mesh: null
  }
  arrows: ShaderMesh = {
    geometry: null,
    positions: null,
    rotates: null,
    material: null,
    mesh: null
  }
  hlLine: ShaderMesh = {
    geometry: null,
    positions: null,
    material: null,
    mesh: null
  }
  hlNodes: ShaderMesh = {
    geometry: null,
    positions: null,
    scale: null,
    material: null,
    mesh: null
  }
  hlArrow: ShaderMesh = {
    geometry: null,
    positions: null,
    rotates: null,
    material: null,
    mesh: null
  }
  hlText: Mesh = {
    geometry: null,
    material: null,
    mesh: null
  }

  constructor(dom: HTMLElement, data: GraphData, graphBaseConfig: GraphBaseConfig = GRAPH_BASE_CONFIG) {
    this.$container = dom
    this.data = data
    this.config = Object.assign({}, GRAPH_BASE_CONFIG, graphBaseConfig)
    this.perfInfo = GRAPH_DEFAULT_PERF_INFO

    this.init()
  }

  init() {
    this.processedData = this.preProcessData()

    this.perfInfo.nodeCounts = this.processedData.nodes.length
    this.perfInfo.linkCounts = this.processedData.links.length

    this.prepareScene()
    this.prepareBasicMesh()
    this.installControls()

    this.initWorker()
  }

  /**
   * preProcessData
   * preprocess data
   *
   * @returns {ProcessedData}
   * @memberof D3ForceGraph
   */
  preProcessData(): ProcessedData {
    let result: ProcessedData = {
      nodes: [],
      links: [],
      nodeInfoMap: {},
      linkInfoMap: {},
      statTable: [],
      linkBuffer: null
    }

    let nodeCount = 0

    this.data.nodes.forEach(e => {
      if(!result.nodeInfoMap[e.id]) {
        result.nodes.push({
          id: e.id
        })
        result.nodeInfoMap[e.id] = {
          index: nodeCount,
          scale: e.scale,
          image: e.image,
          name: e.name
        }
        nodeCount++
      }
    })

    let linkCount = 0
    let linkCountMap: {
      [key: string]: number
    } = {}
    let linkBuffer: Array<number> = []

    this.data.links.forEach(e => {
      let linkInfoKey = `${e.source}-${e.target}`
      if(!result.linkInfoMap[linkInfoKey]) {
        result.links.push({
          source: e.source,
          target: e.target
        })
        linkBuffer.push(result.nodeInfoMap[e.source].index, result.nodeInfoMap[e.target].index)
        result.linkInfoMap[linkInfoKey] = {
          color: e.color
        }
        linkCountMap[e.source] = (linkCountMap[e.source] || 0) + 1
        linkCount++
      }
    })

    result.linkBuffer = new Int32Array(linkBuffer)

    result.statTable = Object.keys(linkCountMap).map(e => {
      return {
        source: e,
        count: linkCountMap[e]
      }
    }).sort((a, b) => {
      return b.count - a.count
    })

    if(result.statTable.length > 20) {
      result.statTable.length = 20
    }

    return result
  }

  prepareScene(): void {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x000010)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true
    })
    this.renderer.setSize(this.config.width, this.config.height)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.$container.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(45, this.config.width / this.config.height, 40, 18000)
    this.camera.position.set(0, 0, this.getPositionZ(this.processedData.nodes.length))
    this.camera.up = new THREE.Vector3(0, 0, 1)
    this.camera.updateProjectionMatrix()
    this.renderer.render(this.scene, this.camera)
    this.containerRect = this.$container.getBoundingClientRect()
  }

  prepareBasicMesh(): void {
    // 预准备节点与线，使用BufferGeometry，位置先定到-9999
    // z 关系
    // 高亮节点：0.01
    // 头像：0.005
    // 节点: 0
    // 高亮箭头：-0.04
    // 箭头：-0.05
    // 高亮线：-0.09
    // 线：-0.1
    this.perfInfo.layoutStartTime = Date.now()

    this.nodes.geometry = new THREE.BufferGeometry()
    this.nodes.positions = new Float32Array(this.perfInfo.nodeCounts * 3)
    this.nodes.scale = new Float32Array(this.perfInfo.nodeCounts)

    this.nodes.material = new THREE.ShaderMaterial({
      uniforms: {
        texture: {
          type: 't',
          value: NODE_TEXTURE
        }
      },
      vertexShader: nodesVS,
      fragmentShader: nodesFS
    })

    this.processedData.nodes.forEach((e, i) => {
      this.nodes.positions[i * 3] = -9999
      this.nodes.positions[i * 3 + 1] = -9999
      this.nodes.positions[i * 3 + 2] = 0
      this.nodes.scale[i] = this.processedData.nodeInfoMap[e.id].scale || 1
    })

    this.nodes.geometry.addAttribute('position', new THREE.BufferAttribute(this.nodes.positions, 3))
    this.nodes.geometry.addAttribute('scale', new THREE.BufferAttribute(this.nodes.scale, 1))
    this.nodes.geometry.computeBoundingSphere()
    this.nodes.mesh = new THREE.Points(this.nodes.geometry, this.nodes.material)
    this.nodes.mesh.name = 'basePoints'
    this.scene.add(this.nodes.mesh)

    this.lines.geometry = new THREE.BufferGeometry()
    this.lines.positions = new Float32Array(this.perfInfo.linkCounts * 6)
    this.lines.colors = new Float32Array(this.perfInfo.linkCounts * 6)

    this.lines.material = new THREE.ShaderMaterial({
      transparent: true,
      opacity: 0.6,
      vertexShader: linesVS,
      fragmentShader: linesFS
    })

    this.processedData.links.forEach((e, i) => {
      this.lines.positions[i * 6] = -9999
      this.lines.positions[i * 6 + 1] = -9999
      this.lines.positions[i * 6 + 2] = -0.1
      this.lines.positions[i * 6 + 3] = -9999
      this.lines.positions[i * 6 + 4] = -9999
      this.lines.positions[i * 6 + 5] = -0.1

      if(this.processedData.linkInfoMap[`${e.source}-${e.target}`].color) {
        this.lines.colors[i * 6] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[0]
        this.lines.colors[i * 6 + 1] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[1]
        this.lines.colors[i * 6 + 2] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[2]
        this.lines.colors[i * 6 + 3] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[0]
        this.lines.colors[i * 6 + 4] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[1]
        this.lines.colors[i * 6 + 5] = this.processedData.linkInfoMap[`${e.source}-${e.target}`].color[2]
      }else {
        this.lines.colors[i * 6] = 1
        this.lines.colors[i * 6 + 1] = 1
        this.lines.colors[i * 6 + 2] = 1
        this.lines.colors[i * 6 + 3] = 1
        this.lines.colors[i * 6 + 4] = 1
        this.lines.colors[i * 6 + 5] = 1
      }
    })

    this.lines.geometry.addAttribute('position', new THREE.BufferAttribute(this.lines.positions, 3))
    this.lines.geometry.addAttribute('color', new THREE.BufferAttribute(this.lines.colors, 3))
    this.lines.geometry.computeBoundingSphere()

    this.lines.mesh = new THREE.LineSegments(this.lines.geometry, this.lines.material)
    this.lines.mesh.name = 'baseLines'
    this.scene.add(this.lines.mesh)
  }

  initWorker(): void {
    let blob = new Blob([worker], {
      type: 'text/javascript'
    })

    this.worker = new Worker(window.URL.createObjectURL(blob))
  }

  start(): void {
    let message = {
      type: 'start',
      nodes: this.perfInfo.nodeCounts,
      DISTANCE: this.getDistance(this.perfInfo.nodeCounts),
      STRENGTH: this.getStrength(this.perfInfo.nodeCounts),
      COL: this.getCol(this.perfInfo.nodeCounts),
      linksBuffer: this.processedData.linkBuffer.buffer
    }

    this.worker.postMessage(message, [message.linksBuffer])

    this.worker.onmessage = (event) => {
      switch (event.data.type) {
        case('tick'): {
          // 每次 tick 时，记录该次 tick 时间和与上次 tick 的时间差，用于补间动画
          let now = Date.now()
          this.perfInfo.layouting = true
          this.perfInfo.layoutProgress = (event.data.progress * 100).toFixed(2)
          this.perfInfo.layoutPastTime = now - this.perfInfo.layoutStartTime

          this.perfInfo.intervalTime = now - (this.perfInfo.prevTickTime || now)
          // console.log(`计算间隔时间${this.intervalTime}, 当期时刻${now - this.perfInfo.layoutStartTime}, 上个tick时刻${this.prevTickTime}`)
          this.perfInfo.prevTickTime = now

          if(event.data.currentTick === 1) {
            // 第一帧不画，只记录
            this.targetPositionStatus = new Float32Array(event.data.nodes)
          }else {
            // 第二帧开始画第一帧，同时启动补间
            if(event.data.currentTick === 2) {
              this.currentPositionStatus = this.targetPositionStatus
              this.startRender()
            }

            this.targetPositionStatus = new Float32Array(event.data.nodes)
            // 缓存当前 this.currentPositionStatus
            if(this.currentPositionStatus) {
              let len = this.currentPositionStatus.length
              if(!this.cachePositionStatus) {
                this.cachePositionStatus = new Float32Array(len)
              }
              for(let i = 0; i < len; i++) {
                this.cachePositionStatus[i] = this.currentPositionStatus[i]
              }
            }
            this.perfInfo.targetTick = event.data.currentTick
          }

          break
        }
        case('end'): {
          this.targetPositionStatus = new Float32Array(event.data.nodes)

          this.$container.addEventListener('mousemove', this.mouseMoveHandler, false)
          this.$container.addEventListener('mouseout', this.mouseOutHandler, false)

          // 布局结束后，如果鼠标不在图像区域，就停止渲染（节能）
          setTimeout(() => {
            this.perfInfo.layouting = false
            this.renderArrow()

            setTimeout(() => {
              if(!this.mouseStatus.mouseOnChart && !this.mouseStatus.mouseOnTable) {
                this.stopRender()
              }
            }, 2000)
          }, 2000)
          break
        }
      }
    }
  }

  installControls(): void {
    this.controls = new (THREE as any).MapControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.25
    this.controls.screenSpacePanning = false
    this.controls.maxPolarAngle = Math.PI / 2
  }

  // 启动渲染
  startRender(): void {
    if(!this.rafId) {
      this.rafId = requestAnimationFrame(this.render)
    }
  }

  // 停止渲染，节约性能
  stopRender(): void {
    if(this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  render(): void {
    this.rafId = null
    // 限制放大缩小距离，最近75，最远16000
    if(this.camera.position.z < 75) {
      this.camera.position.set(this.camera.position.x, this.camera.position.y, 75)
    }
    if(this.camera.position.z > 16000) {
      this.camera.position.set(this.camera.position.x, this.camera.position.y, 16000)
    }
    // 节点数大于1000时，执行补间动画
    if(this.perfInfo.nodeCounts > 1000) {
      let now = Date.now()
      let stepTime = now - this.perfInfo.prevTickTime
      // console.log(`开始准备渲染, 当前渲染时间点${now - this.perf.layoutStartTime}, 当前tick${this.targetTick}更新时间点${this.prevTickTime - this.perf.layoutStartTime}, 间隔${this.intervalTime}, 理论进度${stepTime/this.intervalTime}`)
      if(stepTime <= this.perfInfo.intervalTime) {
        for(let i = 0; i < this.currentPositionStatus.length; i++) {
          this.currentPositionStatus[i] = (this.targetPositionStatus[i] - this.cachePositionStatus[i]) / this.perfInfo.intervalTime * stepTime + this.cachePositionStatus[i]
        }
        this.updatePosition(this.currentPositionStatus)
      }
      if(!this.perfInfo.layouting && (this.currentPositionStatus[0] !== this.targetPositionStatus[0])){
        this.currentPositionStatus = this.targetPositionStatus
        this.updatePosition(this.currentPositionStatus)
      }
    }else {
      this.currentPositionStatus = this.targetPositionStatus
      this.updatePosition(this.currentPositionStatus)
    }
    this.updateHighLight()
    if(!this.perfInfo.layouting && this.camera.position.z < 300) {
      // todo 智能卸载
      this.loadImage()
    }
    this.renderer.render(this.scene, this.camera)
    this.controls && this.controls.update()
    this.startRender()
  }

  renderArrow(): void {
    this.arrows.geometry = new THREE.BufferGeometry()
    this.arrows.positions = new Float32Array(this.perfInfo.linkCounts * 3)
    this.arrows.rotates = new Float32Array(this.perfInfo.linkCounts)

    this.arrows.material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        texture: {
          type: 't',
          value: ARROW_TEXTURE
        }
      },
      vertexShader: arrowsVS,
      fragmentShader: arrowsFS
    })

    let vec: v3.Vector3 = new v3.Vector3(0, 1, 0)
    let up: v3.Vector3 = new v3.Vector3(0, 1, 0)
    let offsetDistance = 2.9

    this.processedData.links.forEach((e, i) => {

      // 计算箭头的旋转方向与偏移位置
      let vecX = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2] - this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2]
      let vecY = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2 + 1] - this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2 + 1]
      vec.x = vecX
      vec.y = vecY
      let angle = v3.Vector3.getAngle(vec, up)
      let vecNorm = v3.Vector3.getNorm(vec)
      let offsetX = vecX * offsetDistance / vecNorm
      let offsetY = vecY * offsetDistance / vecNorm
      if(vecX < 0) {
        angle = 2 * Math.PI - angle
      }
      this.arrows.rotates[i] = angle

      this.arrows.positions[i * 3] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2] - offsetX
      this.arrows.positions[i * 3 + 1] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2 + 1] - offsetY
      this.arrows.positions[i * 3 + 2] = -0.05
    })

    this.arrows.geometry.addAttribute('position', new THREE.BufferAttribute(this.arrows.positions, 3))
    this.arrows.geometry.addAttribute('rotate', new THREE.BufferAttribute(this.arrows.rotates, 1))
    this.arrows.geometry.computeBoundingSphere()
    this.arrows.mesh = new THREE.Points(this.arrows.geometry, this.arrows.material)
    this.arrows.mesh.name = 'arrows'
    this.scene.add(this.arrows.mesh)
  }

  // 更新节点与线的位置
  updatePosition(nodesPosition: Float32Array): void {
    for(let i = 0; i < this.perfInfo.nodeCounts; i++) {
      this.nodes.positions[i * 3] = nodesPosition[i * 2]
      this.nodes.positions[i * 3 + 1] = nodesPosition[i * 2 + 1]
    }
    this.nodes.geometry.attributes.position = new THREE.BufferAttribute(this.nodes.positions, 3)
    this.nodes.geometry.attributes.position.needsUpdate = true
    this.nodes.geometry.computeBoundingSphere()
    for(let i = 0; i < this.perfInfo.linkCounts; i++) {
      this.lines.positions[i * 6] = nodesPosition[this.processedData.nodeInfoMap[this.processedData.links[i].source].index * 2]
      this.lines.positions[i * 6 + 1] = nodesPosition[this.processedData.nodeInfoMap[this.processedData.links[i].source].index * 2 + 1]
      this.lines.positions[i * 6 + 3] = nodesPosition[this.processedData.nodeInfoMap[this.processedData.links[i].target].index * 2]
      this.lines.positions[i * 6 + 4] = nodesPosition[this.processedData.nodeInfoMap[this.processedData.links[i].target].index * 2 + 1]
    }
    this.lines.geometry.attributes.position = new THREE.BufferAttribute(this.lines.positions, 3)
    this.lines.geometry.attributes.position.needsUpdate = true
    this.lines.geometry.computeBoundingSphere()
  }

  // 响应鼠标在图表上移动时的交互，指到某个节点上进行高亮
  updateHighLight(): void {
    let normalMouse = new THREE.Vector2()
    normalMouse.x = this.mouseStatus.mousePosition.x * 2 / this.config.width
    normalMouse.y = this.mouseStatus.mousePosition.y * 2 / this.config.height
    let ray = new THREE.Raycaster()
    ray.setFromCamera(normalMouse, this.camera)
    ray.params.Points.threshold = 2
    let intersects = ray.intersectObjects(this.scene.children).filter(e => e.object.type === 'Points' && !e.object.name.startsWith('hl'))
    if(intersects.length > 0) {
      let target = intersects[0]
      let id
      if(target.object && target.object.name === 'basePoints') {
        id = this.processedData.nodes[target.index].id
      }else if(target.object && target.object.name.startsWith('ava-')) {
        id = (target.object as any).nodeId
      }
      if(id) {
        this.highlight(id)
      }
    }else {
      if(!this.mouseStatus.mouseOnTable) {
        this.unhighlight()
      }
    }
  }

  loadImage(): void {
    // 节流
    if(!this.throttleTimer) {
      this.throttleTimer = window.setTimeout(() => {
        // console.log('timer 执行')
        if(this.camera.position.z > 300) {
          return
        }

        let nodes = this.getAllVisibleNodes()
        let nullc = 0
        let defaultc = 0
        let havec = 0

        for(let i = 0, len = nodes.length; i < len; i++) {
          let id = nodes[i].id
          let x = this.currentPositionStatus[this.processedData.nodeInfoMap[id].index * 2]
          let y = this.currentPositionStatus[this.processedData.nodeInfoMap[id].index * 2 + 1]
          let info = this.processedData.nodeInfoMap[id]

          if(!info.imageTexture) {
            if((!id.startsWith('null') && !info.image) || info.image === 'http://img.geilicdn.com/u_default.jpg') {
              defaultc++
              this.getRoundImage(`/_/wx.png`).then((canvas) => {
                info.imageTexture = new THREE.Texture(canvas)
                info.imageTexture.needsUpdate = true
                this.generateAvaPoint(info, id, x, y)
              }).catch(() => {
                info.image = null
              })
            }else if(info.image){
              havec++
              this.getRoundImage(`${info.image}?w=64&h=64`).then((canvas) => {
                info.imageTexture = new THREE.Texture(canvas)
                info.imageTexture.needsUpdate = true
                this.generateAvaPoint(info, id, x, y)
              }).catch(() => {
                info.image = null
              })
            }else {
              nullc++
            }
          }else {
            this.generateAvaPoint(info, id, x, y)
          }
        }
        console.log(`同屏节点${nodes.length}个，游客${nullc}个，默认头像${defaultc}个，自定义头像${havec}个`)
        this.throttleTimer = null
      }, 1000)
    }else {
      console.log('wait timer 执行')
    }
  }
  generateAvaPoint(info: ProcessedData['nodeInfoMap']['key'], id: string, x: number, y: number): void {
    if(!info.imagePoint) {
      info.imagePoint = {
        geometry: null,
        material: null,
        positions: new Float32Array([x, y, 0.005]),
        mesh: null
      }
      info.imagePoint.geometry = new THREE.BufferGeometry()
      info.imagePoint.material = new THREE.ShaderMaterial({
        uniforms: {
          texture: {
            type: 't',
            value: info.imageTexture
          }
        },
        vertexShader: imageVS,
        fragmentShader: imageFS
      })

      info.imagePoint.geometry.addAttribute('position', new THREE.BufferAttribute(info.imagePoint.positions, 3))
      info.imagePoint.geometry.computeBoundingSphere()

      info.imagePoint.mesh = new THREE.Points(info.imagePoint.geometry, info.imagePoint.material)
      info.imagePoint.mesh.name = `ava-${id}`
      ;(info.imagePoint.mesh as any).nodeId = id
    }
    if(!this.scene.getObjectByName(`ava-${id}`)) {
      this.scene.add(info.imagePoint.mesh)
      console.log('loadImage:', id)
    }
  }
  // 获取当前 viewport 下所以可视的节点
  getAllVisibleNodes(): Array<VisibleNode> {
    let viewportRect = this.getViewPortRect()
    let result = []
    for(let i = 0, len = this.perfInfo.nodeCounts; i < len; i++) {
      if(this.targetPositionStatus[i * 2] >= viewportRect.left && this.targetPositionStatus[i * 2] <= viewportRect.right && this.targetPositionStatus[i * 2 + 1] >= viewportRect.bottom && this.targetPositionStatus[i * 2 + 1] <= viewportRect.top) {
        result.push({
          id: this.processedData.nodes[i].id,
          x: this.targetPositionStatus[i * 2],
          y: this.targetPositionStatus[i * 2 + 1]
        })
      }
    }
    return result
  }
  // 根据透视投影模型，计算当前可视区域
  getViewPortRect(): ViewportRect {
    let offsetY = this.camera.position.z * Math.tan(Math.PI / 180 * 22.5)
    let offsetX = offsetY * this.camera.aspect
    return {
      left: this.camera.position.x - offsetX,
      right: this.camera.position.x + offsetX,
      top: this.camera.position.y + offsetY,
      bottom: this.camera.position.y - offsetY
    }
  }
  getRoundImage(url: string): Promise<HTMLCanvasElement> {
    return new Promise((res, rej) => {
      let scaleCanvas = document.createElement('canvas')
      let scaleContext = scaleCanvas.getContext('2d')
      scaleCanvas.width = 64
      scaleCanvas.height = 64
      let img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      img.onload = () => {
        scaleContext.clearRect(0, 0, 64, 64)
        scaleContext.drawImage(img, 0, 0, 64, 64)
        let clipCanvas = document.createElement('canvas')
        let clipContext = clipCanvas.getContext('2d')
        clipCanvas.width = 64
        clipCanvas.height = 64
        clipContext.clearRect(0, 0, 64, 64)
        let pattern = clipContext.createPattern(scaleCanvas, 'no-repeat')
        clipContext.arc(32, 32, 32, 0, 2 * Math.PI)
        clipContext.fillStyle = pattern
        clipContext.fill()
        res(clipCanvas)
      }
      img.onerror = () => {
        rej()
      }
    })
  }

  highlight(id: string): void {
    if(this.highlighted !== id) {
      this.addHighLight(id)
      this.highlighted = id
    }
  }

  unhighlight(): void {
    let node = this.scene.getObjectByName('hlNodes')
    let line = this.scene.getObjectByName('hlLines')
    let text = this.scene.getObjectByName('hlText')
    let arrow = this.scene.getObjectByName('hlArrows')
    this.scene.remove(node)
    this.scene.remove(line)
    this.scene.remove(text)
    this.scene.remove(arrow)
    this.highlighted = null
  }

  // 根据 id 高亮节点
  addHighLight(sourceId: string): void {

    // console.log(sourceId, this.processedData.nodeInfoMap[sourceId].ava)
    let sourceNode = this.processedData.nodes.find(e => e.id === sourceId)
    let links = this.processedData.links.filter(e => (e.source === sourceId || e.target === sourceId))
    let targetNodes = links.map(e => {
      return e.target === sourceNode.id ? e.source : e.target
    })
    targetNodes.push(sourceNode.id)

    this.hlNodes.geometry = new THREE.BufferGeometry()
    this.hlNodes.positions = new Float32Array(targetNodes.length * 3)
    this.hlNodes.scale = new Float32Array(targetNodes.length)
    this.hlNodes.material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        texture: {
          type: 't',
          value: NODE_TEXTURE
        }
      },
      vertexShader: hlNodesVS,
      fragmentShader: hlNodesFS
    })

    targetNodes.forEach((e, i) => {
      this.hlNodes.positions[i * 3] = this.currentPositionStatus[this.processedData.nodeInfoMap[e].index * 2]
      this.hlNodes.positions[i * 3 + 1] = this.currentPositionStatus[this.processedData.nodeInfoMap[e].index * 2 + 1]
      this.hlNodes.positions[i * 3 + 2] = 0.01
      this.hlNodes.scale[i] = this.processedData.nodeInfoMap[e].scale || 1
    })

    this.hlNodes.geometry.addAttribute('position', new THREE.BufferAttribute(this.hlNodes.positions, 3))
    this.hlNodes.geometry.addAttribute('scale', new THREE.BufferAttribute(this.hlNodes.scale, 1))
    this.hlNodes.geometry.computeBoundingSphere()

    this.hlNodes.mesh = new THREE.Points(this.hlNodes.geometry, this.hlNodes.material)
    this.hlNodes.mesh.name = 'hlNodes'
    this.scene.add(this.hlNodes.mesh)

    this.hlLine.geometry = new THREE.BufferGeometry()
    this.hlLine.positions = new Float32Array(links.length * 6)
    this.hlLine.material = new THREE.ShaderMaterial({
      opacity: 0.6,
      vertexShader: hlLinesVS,
      fragmentShader: hlLinesFS
    })

    links.forEach((e, i) => {
      this.hlLine.positions[i * 6] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2]
      this.hlLine.positions[i * 6 + 1] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2 + 1]
      this.hlLine.positions[i * 6 + 2] = -0.09
      this.hlLine.positions[i * 6 + 3] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2]
      this.hlLine.positions[i * 6 + 4] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2 + 1]
      this.hlLine.positions[i * 6 + 5] = -0.09
    })

    this.hlLine.geometry.addAttribute('position', new THREE.BufferAttribute(this.hlLine.positions, 3))
    this.hlLine.geometry.computeBoundingSphere()

    this.hlLine.mesh = new THREE.LineSegments(this.hlLine.geometry, this.hlLine.material)
    this.hlLine.mesh.name = 'hlLine'
    this.scene.add(this.hlLine.mesh)

    this.hlArrow.geometry = new THREE.BufferGeometry()
    this.hlArrow.positions = new Float32Array(links.length * 3)
    this.hlArrow.rotates = new Float32Array(links.length)

    this.hlArrow.material = new THREE.ShaderMaterial({
      uniforms: {
        texture: {
          type: 't',
          value: ARROW_TEXTURE
        }
      },
      vertexShader: ``,
      fragmentShader: ``
    })

    let vec = new v3.Vector3(0, 1, 0)
    let up = new v3.Vector3(0, 1, 0)
    let offsetDistance = 2.9

    links.forEach((e, i) => {

      // 计算箭头的旋转方向与偏移位置
      let vecX = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2] - this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2]
      let vecY = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2 + 1] - this.currentPositionStatus[this.processedData.nodeInfoMap[e.source].index * 2 + 1]
      vec.x = vecX
      vec.y = vecY
      let angle = v3.Vector3.getAngle(vec, up)
      let vecNorm = v3.Vector3.getNorm(vec)
      let offsetX = vecX * offsetDistance / vecNorm
      let offsetY = vecY * offsetDistance / vecNorm
      if(vecX < 0) {
        angle = 2 * Math.PI - angle
      }
      this.hlArrow.rotates[i] = angle

      this.hlArrow.positions[i * 3] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2] - offsetX
      this.hlArrow.positions[i * 3 + 1] = this.currentPositionStatus[this.processedData.nodeInfoMap[e.target].index * 2 + 1] - offsetY
      this.hlArrow.positions[i * 3 + 2] = -0.04
    })

    this.hlArrow.geometry.addAttribute('position', new THREE.BufferAttribute(this.hlArrow.positions, 3))
    this.hlArrow.geometry.addAttribute('rotate', new THREE.BufferAttribute(this.hlArrow.rotates, 1))
    this.hlArrow.geometry.computeBoundingSphere()
    this.hlArrow.mesh = new THREE.Points(this.hlArrow.geometry, this.hlArrow.material)
    this.hlArrow.mesh.name = 'hlArrow'
    this.scene.add(this.hlArrow.mesh)

    let canvas1 = document.createElement('canvas')
    let context1 = canvas1.getContext('2d')
    canvas1.width = 512
    canvas1.height = 64
    context1.clearRect(0, 0, canvas1.width, canvas1.height)
    context1.font = 'Bold 24px Arial'
    context1.textAlign = 'center'
    context1.fillStyle = 'rgb(255,255,255)'
    let text = sourceId.startsWith('null') ? 'null' : (this.processedData.nodeInfoMap[sourceId].name || sourceId)
    context1.fillText(text, canvas1.width / 2, 50)
    let fontTexture = new THREE.Texture(canvas1)
    fontTexture.needsUpdate = true
    this.hlText.material = new THREE.MeshBasicMaterial({
      map: fontTexture,
      side: THREE.DoubleSide,
      alphaTest: 0.5
    })
    this.hlText.material.transparent = true
    this.hlText.mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(canvas1.width, canvas1.height),
        this.hlText.material as THREE.MeshBasicMaterial
    )
    this.hlText.mesh.scale.set(0.12, 0.12, 0.12)
    let fontMeshPosition = [this.currentPositionStatus[this.processedData.nodeInfoMap[sourceId].index * 2], this.currentPositionStatus[this.processedData.nodeInfoMap[sourceId].index * 2 + 1] - 4, 0.02]
    this.hlText.mesh.position.set(fontMeshPosition[0], fontMeshPosition[1], 0)
    this.hlText.mesh.name = 'hlText'
    this.scene.add(this.hlText.mesh)
  }

  mouseMoveHandler(event: MouseEvent): void {
    this.mouseStatus.mouseOnChart = true
    this.mouseStatus.mousePosition.x = event.clientX - this.containerRect.left - this.config.width / 2
    this.mouseStatus.mousePosition.y = this.config.height - event.clientY + this.containerRect.top - this.config.height / 2
  }
  mouseOutHandler(): void {
    this.mouseStatus.mouseOnChart = false
    this.mouseStatus.mousePosition.x = -9999
    this.mouseStatus.mousePosition.y = -9999
  }
  chartMouseEnterHandler(): void {
    this.mouseStatus.mouseOnChart = true
    // 开启渲染
    this.startRender()
  }
  chartMouseLeaveHandler(): void {
    this.mouseStatus.mouseOnChart = false
    // 关闭渲染
    if(!this.perfInfo.layouting) {
      this.stopRender()
    }
  }

  // Fitting equation (Four Parameter Logistic Regression)
  // nodesCount: 14,969,11007,50002
  // z: 500,3000,7500,16000
  // nodesCount: 14,764,11007,50002
  // COL: 2,2.5,3.5,5
  // DISTANCE: 20,25,40,50
  // STRENGTH: 3,5,8,10
  getPositionZ(nodesCount: number): number {
    return (3.04139028390183E+16 - 150.128392537138) / (1 + Math.pow(nodesCount / 2.12316143430556E+31, -0.461309470817812)) + 150.128392537138
  }
  getDistance(nodesCount: number): number {
    return (60.5026920478786 - 19.6364818002641) / (1 + Math.pow(nodesCount / 11113.7184968341, -0.705912886177758)) + 19.6364818002641
  }
  getStrength(nodesCount: number): number {
    return -1 * ((15.0568640234622 - 2.43316256810301) / (1 + Math.pow(nodesCount / 19283.3978670675, -0.422985777119439)) + 2.43316256810301)
  }
  getCol(nodesCount: number): number {
    return (2148936082128.1 - 1.89052009608515) / (1 + Math.pow(nodesCount / 7.81339751933109E+33, -0.405575129002072)) + 1.89052009608515
  }
}
