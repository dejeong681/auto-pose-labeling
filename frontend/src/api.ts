import type { ImageInfo, PersonLabel, PoseResponse, SavedLabels } from './types';
import { summarizePeople } from './pose-classes';

type DeleteImagesResult = {
  deleted: string[];
  failed: { filename: string; message: string }[];
  cleanup_pending: string[];
};

type SaveBboxLabelsResult = {
  saved: string[];
  skipped: string[];
  failed: { filename: string; message: string }[];
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function checkResponse(response: Response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(typeof data.detail === 'string' ? data.detail : '요청을 처리하지 못했습니다. 입력값과 서버를 확인하세요.', response.status);
  }
  return response;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  return (await checkResponse(await fetch(path, options))).json();
}

const imagePath = (filename: string) => `/api/images/${encodeURIComponent(filename)}`;
const jsonBody = (people: PersonLabel[]) => ({
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ people }),
});

export const listImages = (signal?: AbortSignal) => request<ImageInfo[]>('/api/images', { signal });
export function uploadImage(file: File) {
  const body = new FormData();
  body.append('file', file);
  return request<ImageInfo>('/api/images', { method: 'POST', body });
}

export function deleteImages(filenames: string[]) {
  return request<DeleteImagesResult>('/api/images/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filenames }),
  });
}

export function deleteLabels(filenames: string[]) {
  return request<DeleteImagesResult>('/api/images/labels/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filenames }),
  });
}

export function saveBboxLabels(filenames: string[]) {
  return request<SaveBboxLabelsResult>('/api/images/labels/bbox/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filenames }),
  });
}

export const getLabels = (filename: string, signal?: AbortSignal) =>
  request<SavedLabels>(`${imagePath(filename)}/labels`, { signal });
export const saveLabels = (filename: string, people: PersonLabel[], overwrite = true) =>
  request<SavedLabels>(`${imagePath(filename)}/labels${overwrite ? '' : '?overwrite=false'}`, { method: 'PUT', ...jsonBody(people) });
export const estimatePose = (filename: string) =>
  request<PoseResponse>(`${imagePath(filename)}/pose`, { method: 'POST' });

// 한 장·전체 자동 라벨링에서 같은 기준으로 추론 결과를 라벨 초안으로 바꿉니다.
export function poseToLabels(result: PoseResponse): PersonLabel[] {
  return result.people.map((person) => ({
    class_id: 0, box: person.box,
    keypoints: person.keypoints.map((point) => point.usable ?
      { x: point.x, y: point.y, v: 2 } : { x: 0, y: 0, v: 0 }),
  }));
}

export async function autoLabelImage(filename: string) {
  const existing = await getLabels(filename);
  if (existing.exists) return { skipped: true, empty: false, summary: summarizePeople(existing.people) };
  const people = poseToLabels(await estimatePose(filename));
  // 검사 후 추론하는 사이 새 라벨이 생긴 경우도 서버에서 다시 확인합니다.
  const saved = await saveLabels(filename, people, false);
  return { skipped: Boolean(saved.skipped), empty: !saved.skipped && people.length === 0, summary: summarizePeople(saved.people) };
}

// 모델·서버 문제는 다른 이미지에서도 반복되므로 일괄 처리를 멈춥니다.
export function isBatchBlockingError(error: unknown) {
  return error instanceof TypeError || (error instanceof ApiError && (
    [502, 503, 504].includes(error.status) ||
    error.message === '모델 파일이 없습니다.' ||
    error.message === 'COCO 17관절 포즈 모델을 지정하세요.'
  ));
}

export async function downloadJsonLabels(filename: string, people: PersonLabel[]) {
  const response = await checkResponse(await fetch(`${imagePath(filename)}/labels/export`, {
    method: 'POST', ...jsonBody(people),
  }));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/\.[^.]+$/, '') + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
