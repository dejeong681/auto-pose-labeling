import type { ImageInfo, PersonLabel, PoseResponse, SavedLabels } from './types';

async function checkResponse(response: Response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : '요청을 처리하지 못했습니다. 입력값과 서버를 확인하세요.');
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
export const getLabels = (filename: string, signal?: AbortSignal) =>
  request<SavedLabels>(`${imagePath(filename)}/labels`, { signal });
export const saveLabels = (filename: string, people: PersonLabel[]) =>
  request<SavedLabels>(`${imagePath(filename)}/labels`, { method: 'PUT', ...jsonBody(people) });
export const estimatePose = (filename: string) =>
  request<PoseResponse>(`${imagePath(filename)}/pose`, { method: 'POST' });

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
