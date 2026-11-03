// Canvas의 좌표·그리기·마우스 편집을 담당합니다. React 화면은 EditorModal.tsx에 있습니다.
import type { EditMode, EditorSnapshot, JointLabel, PersonLabel } from './types';

type Position = { x: number; y: number };
type Drag =
  | { kind: 'point'; before: JointLabel; start: Position; moved: boolean; pointerId: number }
  | { kind: 'box'; start: Position; end: Position; pointerId: number }
  | { kind: 'pan'; start: Position; offset: Position; pointerId: number };
export const JOINT_NAMES = [
  '코', '왼쪽 눈', '오른쪽 눈', '왼쪽 귀', '오른쪽 귀',
  '왼쪽 어깨', '오른쪽 어깨', '왼쪽 팔꿈치', '오른쪽 팔꿈치',
  '왼쪽 손목', '오른쪽 손목', '왼쪽 엉덩이', '오른쪽 엉덩이',
  '왼쪽 무릎', '오른쪽 무릎', '왼쪽 발목', '오른쪽 발목',
];
const EDGES = [[5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11],
  [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [0, 1], [0, 2], [1, 3], [2, 4]];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const MIN_VISIBLE_IMAGE_PX = 40; // 패닝으로 사진 전체가 화면 밖에 사라지지 않게 일부를 남깁니다.

export class PoseEditor {
  private context: CanvasRenderingContext2D;
  image: HTMLImageElement | null = null;
  people: PersonLabel[] = [];
  selectedPerson = 0;
  selectedJoint = -1;
  zoom = 1;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private pixelRatio = 1;
  private offsetX = 0;
  private offsetY = 0;
  mode: EditMode = 'point';
  disabled = true;
  drag: Drag | null = null;
  private listeners: Record<string, (event: PointerEvent) => void>;
  private wheelListener: (event: WheelEvent) => void;
  private resizeObserver: ResizeObserver;

  constructor(public canvas: HTMLCanvasElement, private onUpdate: (changed: boolean, message: string) => void) {
    this.context = canvas.getContext('2d')!;
    this.listeners = {
      pointerdown: (event) => this.pointerDown(event),
      pointermove: (event) => this.pointerMove(event),
      pointerup: (event) => this.pointerUp(event),
      pointercancel: () => { this.cancelGesture(); this.refresh(); },
    };
    Object.entries(this.listeners).forEach(([name, listener]) => canvas.addEventListener(name, listener as EventListener));
    this.wheelListener = (event) => this.wheel(event);
    canvas.addEventListener('wheel', this.wheelListener, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resizeViewport());
    this.resizeObserver.observe(canvas);
  }

  // 모달이 닫히거나 React가 다시 연결할 때 이벤트가 중복 등록되지 않도록 해제합니다.
  destroy() {
    this.cancelGesture();
    Object.entries(this.listeners).forEach(([name, listener]) => this.canvas.removeEventListener(name, listener as EventListener));
    this.canvas.removeEventListener('wheel', this.wheelListener);
    this.resizeObserver.disconnect();
  }

  snapshot(): EditorSnapshot {
    return { people: this.getPeople(), selectedPerson: this.selectedPerson, selectedJoint: this.selectedJoint,
      mode: this.mode, zoom: this.zoom };
  }

  get person() { return this.people[this.selectedPerson]; }
  get point(): JointLabel | undefined { return this.person?.keypoints[this.selectedJoint]; }
  getPeople() { return clone(this.people); }

  setImage(image: HTMLImageElement | null) {
    this.image = image;
    this.resizeViewport();
    this.resetView();
  }

  private get imageScale() {
    if (!this.image) return 1;
    return Math.min(this.viewportWidth / this.image.naturalWidth, this.viewportHeight / this.image.naturalHeight) * this.zoom;
  }

  private get displaySize() {
    return { width: (this.image?.naturalWidth ?? 1) * this.imageScale,
      height: (this.image?.naturalHeight ?? 1) * this.imageScale };
  }

  resizeViewport() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (this.viewportWidth === rect.width && this.viewportHeight === rect.height && this.pixelRatio === ratio) return;
    const oldSize = this.displaySize;
    const center = { x: (this.viewportWidth / 2 - this.offsetX) / oldSize.width,
      y: (this.viewportHeight / 2 - this.offsetY) / oldSize.height };
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
    this.pixelRatio = ratio;
    // 화면 크기만큼만 버퍼를 만들고, 확대할 때마다 원본에서 다시 그립니다.
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const size = this.displaySize;
    this.offsetX = this.viewportWidth / 2 - center.x * size.width;
    this.offsetY = this.viewportHeight / 2 - center.y * size.height;
    this.limitOffsets();
    this.refresh();
  }

  private limitOffsets() {
    const size = this.displaySize;
    // 기본 배율에서도 이동할 수 있습니다. 사진이 작으면 각 축 길이의 절반을 남깁니다.
    const visibleWidth = Math.min(MIN_VISIBLE_IMAGE_PX, size.width / 2, this.viewportWidth / 2);
    const visibleHeight = Math.min(MIN_VISIBLE_IMAGE_PX, size.height / 2, this.viewportHeight / 2);
    this.offsetX = Math.max(visibleWidth - size.width, Math.min(this.viewportWidth - visibleWidth, this.offsetX));
    this.offsetY = Math.max(visibleHeight - size.height, Math.min(this.viewportHeight - visibleHeight, this.offsetY));
  }

  resetView() {
    this.zoom = 1;
    const size = this.displaySize;
    this.offsetX = (this.viewportWidth - size.width) / 2;
    this.offsetY = (this.viewportHeight - size.height) / 2;
    this.refresh();
  }

  private viewPosition(event: { clientX: number; clientY: number }): Position {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * this.viewportWidth / rect.width,
      y: (event.clientY - rect.top) * this.viewportHeight / rect.height };
  }

  wheel(event: WheelEvent) {
    if (!event.ctrlKey) return;
    event.preventDefault(); // 이미지 위에서 브라우저 전체가 확대되는 것을 막습니다.
    if (!this.image || this.disabled || this.drag) return;
    const cursor = this.viewPosition(event);
    const size = this.displaySize;
    const anchor = { x: (cursor.x - this.offsetX) / size.width, y: (cursor.y - this.offsetY) / size.height };
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewportHeight : 1);
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * Math.exp(-delta * 0.0015)));
    if (next === this.zoom) return;
    this.zoom = next;
    const nextSize = this.displaySize;
    this.offsetX = cursor.x - anchor.x * nextSize.width;
    this.offsetY = cursor.y - anchor.y * nextSize.height;
    this.limitOffsets();
    this.refresh();
  }

  setPeople(people: PersonLabel[], preserveSelection = false) {
    this.cancelGesture();
    this.people = clone(people);
    this.selectedPerson = preserveSelection ? Math.max(0, Math.min(this.selectedPerson, people.length - 1)) : 0;
    this.selectedJoint = preserveSelection ? this.selectedJoint : -1;
    this.mode = 'point';
    this.refresh();
  }

  setDisabled(disabled: boolean) {
    if (disabled) this.cancelGesture();
    this.disabled = disabled;
    this.canvas.classList.toggle('editing-disabled', disabled);
    this.draw();
  }

  refresh(changed = false, message = '') {
    this.draw();
    this.onUpdate(changed, message);
  }

  selectPerson(index: number) {
    this.selectedPerson = index;
    this.selectedJoint = -1;
    this.mode = 'point';
    this.refresh();
  }

  selectJoint(index: number) {
    this.selectedJoint = index;
    this.refresh();
  }

  moveJoint(direction: -1 | 1) {
    if (this.disabled || this.drag || this.mode !== 'point' || !this.person) return;
    // 선택이 없으면 코(0)부터 시작하며, 양 끝에서는 순환하지 않습니다.
    const next = this.selectedJoint < 0 ? 0 :
      Math.max(0, Math.min(JOINT_NAMES.length - 1, this.selectedJoint + direction));
    this.selectJoint(next);
  }

  deselectJoint() {
    if (this.selectedJoint === -1 && this.mode === 'point' && !this.drag) return;
    this.cancelGesture();
    this.selectedJoint = -1;
    this.mode = 'point';
    this.refresh();
  }

  clearJoint() {
    if (!this.point) return;
    this.person.keypoints[this.selectedJoint] = { x: 0, y: 0, v: 0 };
    this.selectedJoint = -1;
    this.refresh(true);
  }

  setClass(value: number) {
    if (!this.person || this.person.class_id === value) return;
    this.person.class_id = value;
    this.refresh(true);
  }

  startBox(mode: 'add' | 'replace') {
    this.cancelGesture();
    this.selectedJoint = -1;
    this.mode = mode;
    this.refresh(false, '이미지에서 대각선으로 드래그하여 사람 박스를 그리세요. Esc로 취소합니다.');
  }

  deletePerson() {
    if (!this.person) return;
    this.people.splice(this.selectedPerson, 1);
    this.selectedPerson = Math.max(0, Math.min(this.selectedPerson, this.people.length - 1));
    this.selectedJoint = -1;
    this.mode = 'point';
    this.refresh(true);
  }

  // 화면 확대와 이동을 역변환합니다. 저장 좌표는 원본 전체 기준 0~1입니다.
  position(event: { clientX: number; clientY: number }, clampToImage = true): Position {
    const point = this.viewPosition(event);
    const size = this.displaySize;
    const x = (point.x - this.offsetX) / size.width;
    const y = (point.y - this.offsetY) / size.height;
    return { x: clampToImage ? clamp(x) : x, y: clampToImage ? clamp(y) : y };
  }

  hitPoint(position: Position): { personIndex: number; jointIndex: number } | null {
    const size = this.displaySize;
    let best: { personIndex: number; jointIndex: number } | null = null;
    let distance = 12; // 클릭 허용 거리: 화면 픽셀
    this.people.forEach((person, personIndex) => person.keypoints.forEach((point, jointIndex) => {
      if (!point.v) return;
      const d = Math.hypot((point.x - position.x) * size.width, (point.y - position.y) * size.height);
      if (d < distance) { distance = d; best = { personIndex, jointIndex }; }
    }));
    return best;
  }

  hitPerson(position: Position): number | null {
    const size = this.displaySize;
    const marginX = 6 / size.width; // 박스 선 바로 옆도 클릭할 수 있는 화면 픽셀 여유입니다.
    const marginY = 6 / size.height;
    let best: number | null = null;
    let smallestArea = Infinity;
    // 겹친 박스는 작은 박스를 우선하며, 크기도 같으면 마지막에 그린 박스를 고릅니다.
    for (let index = this.people.length - 1; index >= 0; index--) {
      const [cx, cy, w, h] = this.people[index].box;
      const inside = position.x >= cx - w / 2 - marginX && position.x <= cx + w / 2 + marginX &&
        position.y >= cy - h / 2 - marginY && position.y <= cy + h / 2 + marginY;
      if (inside && w * h < smallestArea) { best = index; smallestArea = w * h; }
    }
    return best;
  }

  pointerDown(event: PointerEvent) {
    if (this.disabled || !this.image || event.button !== 0 || this.drag) return;
    event.preventDefault();
    // 목록을 선택한 뒤 Canvas를 편집하면 방향키가 다시 이미지 이동에 반응합니다.
    this.canvas.focus({ preventScroll: true });
    const position = this.position(event, false);
    const insideImage = position.x >= 0 && position.x <= 1 && position.y >= 0 && position.y <= 1;
    if (this.mode !== 'point') {
      if (!insideImage) return;
      this.drag = { kind: 'box', start: position, end: position, pointerId: event.pointerId };
    } else {
      // 미지정 관절을 목록에서 고른 경우에만 새 점을 배치합니다.
      const placing = insideImage && this.point?.v === 0;
      const hit = insideImage && !placing ? this.hitPoint(position) : null;
      if (hit) {
        this.selectedPerson = hit.personIndex;
        this.selectedJoint = hit.jointIndex;
      }
      if (hit || placing) {
        if (!this.point) return;
        this.drag = { kind: 'point', before: { ...this.point }, start: position, moved: false, pointerId: event.pointerId };
        // 새 관절은 v=2로 지정합니다. 기존 라벨의 v=1은 이동해도 보존합니다.
        if (!hit) Object.assign(this.point, position, { v: this.drag.before.v || 2 });
      } else {
        // 관절 선택을 해제하고, 박스를 눌렀다면 편집할 사람도 바꿉니다.
        this.selectedJoint = -1;
        const personIndex = insideImage ? this.hitPerson(position) : null;
        if (personIndex !== null) this.selectedPerson = personIndex;
        // 박스 클릭은 선택만 하고, 그대로 끌면 사진을 이동합니다. 라벨은 바꾸지 않습니다.
        this.drag = { kind: 'pan', start: this.viewPosition(event),
          offset: { x: this.offsetX, y: this.offsetY }, pointerId: event.pointerId };
      }
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.refresh();
  }

  pointerMove(event: PointerEvent) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (this.drag.kind === 'pan') {
      const cursor = this.viewPosition(event);
      this.offsetX = this.drag.offset.x + cursor.x - this.drag.start.x;
      this.offsetY = this.drag.offset.y + cursor.y - this.drag.start.y;
      this.limitOffsets();
      this.draw();
      return;
    }
    const position = this.position(event);
    if (this.drag.kind === 'box') this.drag.end = position;
    else {
      const size = this.displaySize;
      const distance = Math.hypot((position.x - this.drag.start.x) * size.width, (position.y - this.drag.start.y) * size.height);
      if (!this.drag.moved && distance < 3) return; // 선택 클릭만으로 점이 움직이지 않습니다.
      this.drag.moved = true;
      if (this.point) Object.assign(this.point, position, { v: this.drag.before.v || 2 });
    }
    this.draw();
  }

  pointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.pointerMove(event);
    let changed = false;
    if (drag.kind === 'box') {
      const size = this.displaySize;
      const w = Math.abs(drag.end.x - drag.start.x);
      const h = Math.abs(drag.end.y - drag.start.y);
      if (w * size.width >= 5 && h * size.height >= 5) {
        const box: PersonLabel['box'] = [(drag.start.x + drag.end.x) / 2, (drag.start.y + drag.end.y) / 2, w, h];
        if (this.mode === 'add') {
          this.people.push({ class_id: 0, box, keypoints: Array.from({ length: 17 }, () => ({ x: 0, y: 0, v: 0 })) });
          this.selectedPerson = this.people.length - 1;
          this.selectedJoint = -1;
        } else if (this.person) this.person.box = box;
        changed = true;
        this.mode = 'point';
      }
    } else if (drag.kind === 'point') changed = JSON.stringify(drag.before) !== JSON.stringify(this.point);
    const placedNewJoint = drag.kind === 'point' && drag.before.v === 0 && changed;
    this.releasePointer();
    // 드래그가 끝난 뒤 선택을 바꿔야 이동 중인 점 대신 다음 관절이 수정되지 않습니다.
    if (placedNewJoint) this.selectedJoint = Math.min(this.selectedJoint + 1, JOINT_NAMES.length - 1);
    this.refresh(changed);
  }

  releasePointer() {
    const pointerId = this.drag?.pointerId;
    this.drag = null;
    if (pointerId !== undefined && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  cancelGesture() {
    if (this.drag?.kind === 'point' && this.point) Object.assign(this.point, this.drag.before);
    if (this.drag?.kind === 'pan') {
      this.offsetX = this.drag.offset.x;
      this.offsetY = this.drag.offset.y;
      this.limitOffsets();
    }
    this.releasePointer();
    this.draw();
  }

  cancelMode() {
    if (!this.drag && this.mode === 'point') return false;
    const panning = this.drag?.kind === 'pan';
    this.cancelGesture();
    this.mode = 'point';
    this.refresh(false, panning ? '사진 이동을 취소했습니다.' : '편집 동작을 취소했습니다.');
    return true;
  }

  draw() {
    this.canvas.classList.toggle('pan-ready', !this.disabled && this.mode === 'point' && this.selectedJoint < 0);
    this.canvas.classList.toggle('panning', !this.disabled && this.drag?.kind === 'pan');
    const ctx = this.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;
    const imageScale = this.imageScale;
    ctx.setTransform(this.pixelRatio * imageScale, 0, 0, this.pixelRatio * imageScale,
      this.pixelRatio * this.offsetX, this.pixelRatio * this.offsetY);
    const width = this.image.naturalWidth;
    const height = this.image.naturalHeight;
    const scale = 1 / imageScale; // 확대해도 점과 선의 화면상 두께는 유지합니다.
    ctx.drawImage(this.image, 0, 0, width, height);
    ctx.lineWidth = 2 * scale;
    ctx.font = `${12 * scale}px Arial`;
    this.people.forEach((person, personIndex) => {
      const [cx, cy, w, h] = person.box;
      ctx.strokeStyle = personIndex === this.selectedPerson ? '#ffce45' : '#00c8e8';
      ctx.strokeRect((cx - w / 2) * width, (cy - h / 2) * height, w * width, h * height);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`person ${personIndex + 1} | class ${person.class_id}`, (cx - w / 2) * width + 4 * scale, Math.max(15 * scale, (cy - h / 2) * height - 6 * scale));
      ctx.strokeStyle = '#00c8e8';
      for (const [a, b] of EDGES) {
        const first = person.keypoints[a];
        const second = person.keypoints[b];
        if (!first.v || !second.v) continue;
        ctx.beginPath();
        ctx.moveTo(first.x * width, first.y * height);
        ctx.lineTo(second.x * width, second.y * height);
        ctx.stroke();
      }
      person.keypoints.forEach((point, index) => {
        if (!point.v) return;
        const selected = personIndex === this.selectedPerson && index === this.selectedJoint;
        ctx.fillStyle = selected ? '#ff4e65' : '#16e45a';
        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, (selected ? 5 : 3) * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(String(index), point.x * width + 5 * scale, Math.max(12 * scale, point.y * height - 5 * scale));
      });
    });
    if (this.drag?.kind === 'box') {
      const { start, end } = this.drag;
      ctx.strokeStyle = '#ff4e65';
      ctx.setLineDash([6 * scale, 4 * scale]);
      ctx.strokeRect(start.x * width, start.y * height, (end.x - start.x) * width, (end.y - start.y) * height);
      ctx.setLineDash([]);
    }
  }
}
