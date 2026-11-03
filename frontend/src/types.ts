// 서버 JSON과 편집기의 공통 형식입니다. 좌표는 이미지 전체 기준 0~1입니다.
export type ImageInfo = { filename: string; url: string; skipped?: boolean };
export type Visibility = 0 | 1 | 2;
export type JointLabel = { x: number; y: number; v: Visibility };
export type PersonLabel = {
  class_id: number;
  box: [number, number, number, number];
  keypoints: JointLabel[];
};
export type SavedLabels = { filename: string; exists: boolean; needs_save: boolean; people: PersonLabel[] };
export type PoseResponse = {
  filename: string;
  people: {
    box: PersonLabel['box'];
    keypoints: { x: number; y: number; confidence: number; usable: boolean }[];
  }[];
};
export type EditMode = 'point' | 'add' | 'replace';
export type EditorSnapshot = {
  people: PersonLabel[];
  selectedPerson: number;
  selectedJoint: number; // -1이면 선택한 관절이 없습니다.
  zoom: number;
  mode: EditMode;
};
