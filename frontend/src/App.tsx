import { useEffect, useRef, useState } from 'react';
import { autoLabelImage, deleteImages, deleteLabels, isBatchBlockingError, listImages, saveBboxLabels, uploadImage } from './api';
import EditorModal from './components/EditorModal';
import ImageList from './components/ImageList';
import { POSE_CLASSES, summarizePeople } from './pose-classes';
import type { ImageInfo, ImageLabelSummary } from './types';

type BatchProgress = {
  total: number; completed: number; saved: number; skipped: number; failed: number; empty: number; current: string;
};

export default function App() {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [selectedImage, setSelectedImage] = useState<ImageInfo | null>(null);
  const [activeFilename, setActiveFilename] = useState('');
  const [uploading, setUploading] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchErrors, setBatchErrors] = useState<{ filename: string; message: string }[]>([]);
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  const [classFilter, setClassFilter] = useState<number[]>([]);
  const [showUnlabeled, setShowUnlabeled] = useState(false);
  const [checkedImages, setCheckedImages] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [savingBbox, setSavingBbox] = useState(false);
  const [labelsOnly, setLabelsOnly] = useState(false);
  const batchRunningRef = useRef(false);
  const [status, setStatus] = useState({ message: '저장된 이미지를 불러오고 있습니다.', error: false });
  const fileInput = useRef<HTMLInputElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const editedLabels = useRef(new Map<string, ImageLabelSummary>());
  const busy = uploading || batchRunning || deleting || savingBbox;

  useEffect(() => {
    const controller = new AbortController();
    listImages(controller.signal).then((items) => {
      setImages(items);
      setStatus({ message: '', error: false });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setStatus({ message: error.message, error: true });
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!batchRunning) return;
    // 브라우저에서 순서대로 요청하므로 작업 중 페이지를 닫기 전에 확인합니다.
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [batchRunning]);

  function openImage(image: ImageInfo) {
    if (busy || batchRunningRef.current) return;
    setActiveFilename(image.filename);
    setSelectedImage(image);
  }

  // 실패 기록의 파일명으로 걸러내며, 서버에서 받은 원래 목록 순서를 유지합니다.
  const failedFilenames = new Set(batchErrors.map((item) => item.filename));
  const failedImages = images.filter((image) => failedFilenames.has(image.filename));
  const availableImages = showFailedOnly ? failedImages : images;
  const hasFilters = classFilter.length > 0 || showUnlabeled;
  const visibleImages = hasFilters
    ? availableImages.filter((image) => {
      const matchesClass = image.class_ids?.some((id) => classFilter.includes(id));
      const isUnlabeled = image.person_count === 0;
      return matchesClass || (showUnlabeled && isUnlabeled);
    })
    : availableImages;
  const checkedVisibleImages = visibleImages.filter((image) => checkedImages.has(image.filename));
  const allVisibleSelected = visibleImages.length > 0 && checkedVisibleImages.length === visibleImages.length;
  const selectedIndex = visibleImages.findIndex((image) => image.filename === selectedImage?.filename);
  function navigateImage(direction: -1 | 1) {
    const next = selectedIndex + direction;
    if (selectedIndex >= 0 && next >= 0 && next < visibleImages.length) openImage(visibleImages[next]);
  }

  function closeEditor() {
    const updates = editedLabels.current;
    if (updates.size) {
      // 편집 중인 이미지가 필터 밖으로 이동해도 현재 모달의 좌우 이동은 유지합니다.
      setImages((items) => items.map((image) => ({ ...image, ...updates.get(image.filename) })));
      editedLabels.current = new Map();
    }
    setSelectedImage(null);
  }

  function checkImage(filename: string, checked: boolean) {
    setCheckedImages((previous) => {
      const next = new Set(previous);
      if (checked) next.add(filename);
      else next.delete(filename);
      return next;
    });
  }

  function openDeleteDialog(onlyLabels: boolean) {
    setLabelsOnly(onlyLabels);
    deleteDialog.current?.showModal();
  }

  async function deleteSelectedImages() {
    if (busy || batchRunningRef.current || !checkedVisibleImages.length) return;
    const filenames = checkedVisibleImages.map((image) => image.filename);
    const subject = labelsOnly ? '라벨' : '이미지';
    deleteDialog.current?.close();
    setDeleting(true);
    setStatus({ message: `${subject} 삭제 중…`, error: false });
    try {
      const result = await (labelsOnly ? deleteLabels(filenames) : deleteImages(filenames));
      const removed = new Set(result.deleted);
      if (labelsOnly) {
        setImages((items) => items.map((image) => removed.has(image.filename)
          ? { ...image, class_ids: [], person_count: 0 }
          : image));
      } else {
        setImages((items) => items.filter((image) => !removed.has(image.filename)));
        if (removed.has(activeFilename)) setActiveFilename('');
      }
      setBatchErrors((items) => items.filter((item) => !removed.has(item.filename)));
      setCheckedImages(new Set(result.failed.map((item) => item.filename)));
      if (!failedImages.some((image) => !removed.has(image.filename))) setShowFailedOnly(false);
      const firstFailure = result.failed[0];
      const messages = [labelsOnly ? `${removed.size}장의 라벨을 비웠습니다.` : `${removed.size}장 삭제했습니다.`];
      if (firstFailure) messages.push(`${result.failed.length}장 삭제 실패 · ${firstFailure.filename} · ${firstFailure.message}`);
      if (result.cleanup_pending.length) messages.push(`${result.cleanup_pending.length}장의 임시 파일을 정리하지 못했습니다. 서버 로그를 확인하세요.`);
      setStatus({ message: messages.join(' '), error: Boolean(firstFailure || result.cleanup_pending.length) });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : `${subject} 삭제에 실패했습니다.`, error: true });
    } finally {
      setDeleting(false);
    }
  }

  async function saveSelectedBboxLabels() {
    if (busy || batchRunningRef.current || !checkedVisibleImages.length) return;
    const filenames = checkedVisibleImages.map((image) => image.filename);
    setSavingBbox(true);
    setStatus({ message: 'bbox 라벨 저장 중…', error: false });
    try {
      const result = await saveBboxLabels(filenames);
      const messages = [`bbox 라벨 ${result.saved.length}장 저장 · data/bbox_labels`];
      if (result.skipped.length) messages.push(`저장된 라벨 없음 ${result.skipped.length}장`);
      const firstFailure = result.failed[0];
      if (firstFailure) messages.push(`실패 ${result.failed.length}장 · ${firstFailure.filename} · ${firstFailure.message}`);
      setStatus({ message: messages.join(' · '), error: result.failed.length > 0 });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : 'bbox 라벨 저장에 실패했습니다.', error: true });
    } finally {
      setSavingBbox(false);
    }
  }

  async function upload(files: File[]) {
    if (!files.length || busy || batchRunningRef.current) return;
    setUploading(true);
    setStatus({ message: '', error: false });
    let failed = 0;
    let firstFailure = '';
    try {
      // 한 파일이 실패해도 나머지 파일은 계속 업로드합니다.
      for (const file of files) {
        try { await uploadImage(file); }
        catch (error) {
          failed++;
          if (!firstFailure) firstFailure = `${file.name}: ${error instanceof Error ? error.message : '업로드에 실패했습니다.'}`;
        }
      }
      // 업로드가 끝나면 목록만 갱신합니다. 편집기는 썸네일을 클릭할 때 엽니다.
      setImages(await listImages());
      setShowFailedOnly(false);
      // 같은 이름은 서버에서 건너뜁니다. 중복 안내는 표시하지 않습니다.
      setStatus({ message: failed ? `업로드 실패 ${failed}장 · 첫 실패 ${firstFailure}` : '', error: failed > 0 });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : '업로드에 실패했습니다.', error: true });
    } finally {
      // 실패 후에도 같은 파일을 다시 선택하면 업로드가 시작되도록 초기화합니다.
      if (fileInput.current) fileInput.current.value = '';
      setUploading(false);
    }
  }

  async function labelAllImages() {
    if (batchRunningRef.current || busy || selectedImage) return;
    // React 상태 갱신 전의 연속 클릭도 막습니다.
    batchRunningRef.current = true;
    setBatchRunning(true);
    setBatchProgress(null);
    setBatchErrors([]);
    setShowFailedOnly(false);
    setCheckedImages(new Set());
    setStatus({ message: '전체 자동라벨링을 준비하고 있습니다.', error: false });
    try {
      const items = await listImages();
      setImages(items);
      if (!items.length) { setStatus({ message: '업로드된 이미지가 없습니다.', error: false }); return; }
      const progress: BatchProgress = { total: items.length, completed: 0, saved: 0, skipped: 0, failed: 0, empty: 0, current: '' };
      const errors: { filename: string; message: string }[] = [];
      const labelSummaries = new Map<string, ImageLabelSummary>();
      let stoppedReason = '';
      for (const image of items) {
        setBatchProgress({ ...progress, current: image.filename });
        try {
          // await를 순서대로 사용하여 CPU에서 한 장씩 추론·저장합니다.
          const result = await autoLabelImage(image.filename);
          labelSummaries.set(image.filename, result.summary);
          if (result.skipped) progress.skipped++;
          else { progress.saved++; if (result.empty) progress.empty++; }
        } catch (error) {
          const reason = error instanceof Error ? error.message : '자동 라벨링에 실패했습니다.';
          progress.failed++;
          errors.push({ filename: image.filename, message: reason });
          setBatchErrors([...errors]);
          if (isBatchBlockingError(error)) stoppedReason = reason;
        }
        progress.completed++;
        setBatchProgress({ ...progress });
        if (stoppedReason) break;
      }
      setImages(items.map((image) => ({ ...image, ...labelSummaries.get(image.filename) })));
      setStatus({
        message: stoppedReason ? `전체 자동라벨링 중단: ${stoppedReason}` :
          progress.failed ? '전체 자동라벨링을 마쳤습니다. 실패한 이미지와 저장한 초안을 확인하세요.' : '전체 자동라벨링 완료. 저장한 초안을 검수하세요.',
        error: Boolean(stoppedReason) || progress.failed > 0,
      });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : '전체 자동라벨링에 실패했습니다.', error: true });
    } finally {
      batchRunningRef.current = false;
      setBatchRunning(false);
    }
  }

  return <>
    <main>
      <h1>Auto Pose Labeling</h1>
      <p className="description">이미지를 선택하고 자동 라벨링으로 관절을 확인하세요.</p>
      <div className="upload-toolbar">
        <button type="button" className="choose-images-button" disabled={busy} onClick={() => fileInput.current?.click()}>
          이미지 선택
        </button>
        <input ref={fileInput} type="file" accept=".jpg,.jpeg,.png,.webp,.bmp" multiple hidden
          disabled={busy} onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
        <button id="auto-label-all" type="button" disabled={busy || !images.length}
          onClick={() => void labelAllImages()}>{batchRunning ? '전체 자동라벨링 중…' : '전체 자동라벨링'}</button>
      </div>
      <div className="image-actions">
        <span>저장된 이미지 {images.length}장</span>
        {POSE_CLASSES.map(({ id, name }) => <label key={id}>
          <input type="checkbox" checked={classFilter.includes(id)} disabled={busy} onChange={(event) => {
            const checked = event.target.checked;
            setClassFilter((previous) => checked ? [...previous, id] : previous.filter((value) => value !== id));
            setCheckedImages(new Set());
          }} />
          {name}
        </label>)}
        <label>
          <input type="checkbox" checked={showUnlabeled} disabled={busy} onChange={(event) => {
            setShowUnlabeled(event.target.checked);
            setCheckedImages(new Set());
          }} />
          미라벨
        </label>
        <label className="select-visible-images">
          <input type="checkbox" disabled={busy || !visibleImages.length}
            checked={allVisibleSelected}
            onChange={(event) => setCheckedImages(new Set(event.target.checked ? visibleImages.map((image) => image.filename) : []))} />
          현재 목록 전체 선택
        </label>
        <div className="image-selection-actions">
          {checkedVisibleImages.length > 0 && <>
            <button type="button" className="save-bbox-labels-button" disabled={busy} onClick={() => void saveSelectedBboxLabels()}>
              {savingBbox ? 'bbox 라벨 저장 중…' : 'bbox 라벨 저장'}
            </button>
            <button type="button" className="delete-images-button" disabled={busy}
              onClick={() => openDeleteDialog(true)}>{deleting && labelsOnly ? '라벨 삭제 중…' : '라벨삭제'}</button>
          </>}
          <button type="button" className="delete-images-button" disabled={busy || !checkedVisibleImages.length}
            onClick={() => openDeleteDialog(false)}>
            {deleting && !labelsOnly ? '삭제 중…' : `삭제${checkedVisibleImages.length ? ` (${checkedVisibleImages.length}장)` : ''}`}
          </button>
        </div>
      </div>
      <p id="status" role="status" aria-live="polite" className={status.error ? 'error' : ''}>{status.message}</p>
      {batchProgress && <section className="batch-progress" aria-label="전체 자동라벨링 진행 상황">
        <progress aria-label="전체 자동라벨링 진행률" value={batchProgress.completed} max={batchProgress.total} />
        <span>처리 {batchProgress.completed}/{batchProgress.total}장 · TXT 저장 {batchProgress.saved}장 · 기존 라벨 건너뜀 {batchProgress.skipped}장 · 실패 {batchProgress.failed}장</span>
        {batchRunning && batchProgress.current && <span>현재 이미지: {batchProgress.current}</span>}
        {batchProgress.empty > 0 && <span>사람 미검출 {batchProgress.empty}장: 빈 TXT로 저장했습니다.</span>}
      </section>}
      {batchErrors.length > 0 && <label className="failed-image-filter">
        <input type="checkbox" checked={showFailedOnly} disabled={busy} onChange={(event) => {
          setShowFailedOnly(event.target.checked);
          setCheckedImages(new Set());
        }} />
        실패한 이미지 {failedImages.length}장
      </label>}
      <ImageList images={visibleImages} activeFilename={activeFilename} onSelect={openImage} disabled={busy}
        checkedImages={checkedImages} onCheck={checkImage}
        title={showFailedOnly ? '실패한 이미지' : '업로드된 이미지'}
        emptyMessage={showFailedOnly || hasFilters ? '조건에 맞는 이미지가 없습니다.' : '저장된 이미지가 없습니다.'} />
    </main>
    <dialog ref={deleteDialog} className="delete-dialog" aria-labelledby="delete-dialog-title">
      <h2 id="delete-dialog-title">선택한 이미지 {checkedVisibleImages.length}장{labelsOnly ? '의 라벨을' : '을'} 삭제할까요?</h2>
      {checkedVisibleImages.length === 1 && <p>{checkedVisibleImages[0].filename}</p>}
      <p>{labelsOnly ? '선택한 이미지의 TXT·JSON 라벨을 삭제합니다.' : '서버에 저장된 이미지와 연결된 라벨이 함께 삭제됩니다.'} 이 작업은 되돌릴 수 없습니다.</p>
      <div className="delete-dialog-actions">
        <button type="button" onClick={() => deleteDialog.current?.close()}>취소</button>
        <button type="button" className="delete-images-button" onClick={() => void deleteSelectedImages()}>{labelsOnly ? '라벨삭제' : '삭제'}</button>
      </div>
    </dialog>
    {selectedImage && <EditorModal key={selectedImage.filename} image={selectedImage}
      imageIndex={selectedIndex} imageCount={visibleImages.length} onNavigate={navigateImage}
      onSave={(labels) => { editedLabels.current.set(labels.filename, summarizePeople(labels.people)); }}
      onClose={closeEditor} />}
  </>;
}
