import type { ImageLabelSummary, PersonLabel } from './types';

// 학습에 사용하는 data.yaml의 클래스 번호와 맞춥니다.
export const POSE_CLASSES = [
  { id: 0, name: 'fall' },
  { id: 1, name: 'not_fall' },
];

export function classIdsFor(people: PersonLabel[]): number[] {
  return [...new Set(people.map((person) => person.class_id))];
}

export function summarizePeople(people: PersonLabel[]): ImageLabelSummary {
  return { class_ids: classIdsFor(people), person_count: people.length };
}
