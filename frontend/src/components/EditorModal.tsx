//브랜치 수정확인작업

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import * as api from '../api';

import { PoseEditor } from '../pose-editor';

import type { EditorSnapshot, ImageInfo, PersonLabel, SavedLabels } from '../types';

import EditorTools from './EditorTools';



type Props = {

  image: ImageInfo;

  imageIndex: number;

  imageCount: number;

  onNavigate: (direction: -1 | 1) => void;

  onClose: () => void;

};

type Busy = '' | 'load' | 'pose' | 'save' | 'reload' | 'download';



export default function EditorModal({ image, imageIndex, imageCount, onNavigate, onClose }: Props) {

  const dialogRef = useRef<HTMLDialogElement>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const editorRef = useRef<PoseEditor | null>(null);

  const readyRef = useRef(false);

  const busyRef = useRef<Busy>('load');

  const backdropStart = useRef(false);

  const [ready, setReady] = useState(false);

  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });

  const [busy, setBusy] = useState<Busy>('load');

  const [savedPeople, setSavedPeople] = useState('[]');

  const [hasSavedTxt, setHasSavedTxt] = useState(false);

  const [labelLoadFailed, setLabelLoadFailed] = useState(false);

  const [status, setStatus] = useState({ message: '', error: false });

  const [snapshot, setSnapshot] = useState<EditorSnapshot>({

    people: [], selectedPerson: 0, selectedJoint: -1, mode: 'point', zoom: 1,

  });

  const dirty = JSON.stringify(snapshot.people) !== savedPeople;

  const disabled = !ready || Boolean(busy);



  function message(text: string, error = false) { setStatus({ message: text, error }); }

  function setAction(value: Busy) {

    busyRef.current = value;

    setBusy(value);

    editorRef.current?.setDisabled(Boolean(value) || !readyRef.current);

  }

  function acceptSaved(data: SavedLabels, preserveSelection = false) {

    // 이전 JSON만 있는 경우에는 수정하지 않아도 TXT 저장 버튼을 누를 수 있습니다.

    setHasSavedTxt(data.exists && !data.needs_save);

    setLabelLoadFailed(false);

    setSavedPeople(JSON.stringify(data.people));

    editorRef.current?.setPeople(data.people, preserveSelection);

  }



  useEffect(() => {

    const dialog = dialogRef.current!;

    const abort = new AbortController();

    let disposed = false;

    const editor = new PoseEditor(canvasRef.current!, (changed, text) => {

      if (disposed) return;

      setSnapshot(editor.snapshot());

      if (text) setStatus({ message: text, error: false });

      else if (changed) setStatus({ message: '수정되었습니다. 저장 버튼 또는 Ctrl+S로 저장하세요.', error: false });

    });

    editorRef.current = editor;

    dialog.showModal();

    document.body.classList.add('modal-open');



    const source = new Image();

    const imageReady = new Promise<HTMLImageElement>((resolve, reject) => {

      source.onload = () => resolve(source);

      source.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));

      source.src = image.url;

    });

    // 각각의 성공·실패를 받아 라벨 오류가 이미지 표시까지 막지 않게 합니다.

    Promise.allSettled([imageReady, api.getLabels(image.filename, abort.signal)]).then(([imageResult, labelResult]) => {

      if (disposed) return;

      if (imageResult.status === 'rejected') throw imageResult.reason;

      const loaded = imageResult.value;

      const data = labelResult.status === 'fulfilled' ? labelResult.value : null;

      const people = data?.people ?? [];

      editor.setImage(loaded);

      setImageSize({ width: loaded.naturalWidth, height: loaded.naturalHeight });

      setSavedPeople(JSON.stringify(people));

      setHasSavedTxt(Boolean(data?.exists && !data.needs_save));

      setLabelLoadFailed(labelResult.status === 'rejected');

      editor.setPeople(people);

      readyRef.current = true;

      setReady(true);

      busyRef.current = '';

      setBusy('');

      editor.setDisabled(false);

      if (labelResult.status === 'rejected') {

        const error = labelResult.reason;

        // 하단에는 기존과 동일한 오류 메시지를 그대로 표시합니다.

        setStatus({ message: error instanceof Error ? error.message : '불러오기에 실패했습니다.', error: true });

      } else {

        setStatus({ message: data?.exists ? '저장된 라벨을 불러왔습니다.' : '자동 라벨링을 실행하거나 사람 박스를 추가하세요.', error: false });

      }

    }).catch((error: Error) => {

      if (disposed) return;

      busyRef.current = '';

      setBusy('');

      setStatus({ message: error.message, error: true });

    });



    // 개발 모드에서도 모달을 반복해서 열 때 요청·이벤트가 남지 않게 정리합니다.

    return () => {

      disposed = true;

      abort.abort();

      editor.destroy();

      editorRef.current = null;

      readyRef.current = false;

      dialog.close();

      document.body.classList.remove('modal-open');

    };

  }, [image.filename, image.url]);



  // hidden이 해제된 직후 크기를 읽어 첫 화면도 바로 정확하게 그립니다.

  useLayoutEffect(() => {

    if (ready) editorRef.current?.resizeViewport();

  }, [ready]);



  function confirmDiscard() {

    return !dirty || window.confirm('저장하지 않은 수정 내용이 있습니다. 버릴까요?');

  }

  function requestClose() {

    if (busyRef.current) { message('작업이 끝난 후 닫을 수 있습니다.'); return; }

    if (confirmDiscard()) onClose();

  }

  function requestNavigate(direction: -1 | 1) {

    // 저장·추론·불러오기가 끝나기 전이나 마우스 드래그 중에는 이동하지 않습니다.

    if (busyRef.current || editorRef.current?.drag) return;

    const next = imageIndex + direction;

    if (imageIndex < 0 || next < 0 || next >= imageCount) return;

    if (confirmDiscard()) onNavigate(direction);

  }

  function canRun() {

    if (!readyRef.current || busyRef.current || !editorRef.current) return false;

    return true;

  }

  async function save() {

    // 읽지 못한 기존 파일을 빈 내용으로 덮어쓰지 않게 버튼과 Ctrl+S 모두에서 막습니다.

    if (!canRun() || (labelLoadFailed && !dirty)) return;

    setAction('save');

    try {

      const data = await api.saveLabels(image.filename, editorRef.current!.getPeople());

      acceptSaved(data, true);

      message('TXT 라벨을 저장했습니다.');

    } catch (error) { message(error instanceof Error ? error.message : '저장에 실패했습니다.', true); }

    finally { setAction(''); }

  }

  async function reload() {

    if (!canRun() || !confirmDiscard()) return;

    setAction('reload');

    try {

      const data = await api.getLabels(image.filename);

      acceptSaved(data);

      message(data.exists ? '저장된 라벨을 다시 불러왔습니다.' : '저장된 라벨이 없습니다.');

    } catch (error) { message(error instanceof Error ? error.message : '불러오기에 실패했습니다.', true); }

    finally { setAction(''); }

  }

  async function estimate() {

    if (!canRun()) return;

    if (snapshot.people.length && !window.confirm('현재 박스와 관절을 자동 라벨링 결과로 교체할까요? 저장 전에는 서버 라벨이 바뀌지 않습니다.')) return;

    setAction('pose');

    message('관절을 분석하고 있습니다.');

    try {

      const result = await api.estimatePose(image.filename);

      const people: PersonLabel[] = result.people.map((person) => ({

        class_id: 0, box: person.box,

        keypoints: person.keypoints.map((point) => point.usable ?

          { x: point.x, y: point.y, v: 2 } : { x: 0, y: 0, v: 0 }),

      }));

      editorRef.current!.setPeople(people);

      message(`사람 ${people.length}명. 관절 위치를 검수한 뒤 저장하세요.`);

    } catch (error) { message(error instanceof Error ? error.message : '추론에 실패했습니다.', true); }

    finally { setAction(''); }

  }

  async function download() {

    if (!canRun()) return;

    setAction('download');

    try {

      await api.downloadJsonLabels(image.filename, editorRef.current!.getPeople());

      message('현재 편집 내용을 JSON으로 다운로드했습니다. 서버 TXT 저장은 저장 버튼으로 합니다.');

    } catch (error) { message(error instanceof Error ? error.message : '내보내기에 실패했습니다.', true); }

    finally { setAction(''); }

  }



  // 키보드 핸들러는 최신 편집 상태를 사용하고 다시 연결하기 전에 이전 것을 해제합니다.

  useEffect(() => {

    function keydown(event: KeyboardEvent) {

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {

        event.preventDefault();

        void save();

        return;

      }

      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

      const jointArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown';

      if (!jointArrow && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      // 관절 목록의 ↑↓만 직접 처리합니다. 입력칸·다른 목록은 기본 동작을 유지합니다.

      const target = event.target;

      if (target instanceof HTMLElement && (target.closest('input, textarea, select') || target.isContentEditable) &&

        !(jointArrow && target.id === 'joint-select')) return;

      event.preventDefault();

      if (event.repeat) return;

      if (jointArrow) {

        if (readyRef.current && !busyRef.current) editorRef.current?.moveJoint(event.key === 'ArrowUp' ? -1 : 1);

      } else requestNavigate(event.key === 'ArrowLeft' ? -1 : 1);

    }

    function beforeUnload(event: BeforeUnloadEvent) {

      if (dirty) { event.preventDefault(); event.returnValue = ''; }

    }

    window.addEventListener('keydown', keydown);

    window.addEventListener('beforeunload', beforeUnload);

    return () => {

      window.removeEventListener('keydown', keydown);

      window.removeEventListener('beforeunload', beforeUnload);

    };

  });



  function outside(event: { clientX: number; clientY: number }) {

    const rect = dialogRef.current!.getBoundingClientRect();

    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;

  }



  return <dialog ref={dialogRef} id="editor-modal" className="editor-modal" aria-labelledby="editor-title"

    onCancel={(event) => {

      event.preventDefault();

      if (!editorRef.current?.cancelMode()) requestClose();

    }}

    onPointerDown={(event) => {

      backdropStart.current = event.target === event.currentTarget && outside(event);

      const target = event.target;

      if (target !== event.currentTarget && target instanceof HTMLElement && !target.closest('canvas, button, input, select, textarea, label')) {

        editorRef.current?.deselectJoint();

      }

    }}

    onClick={(event) => {

      if (backdropStart.current && event.target === event.currentTarget && outside(event)) requestClose();

      backdropStart.current = false;

    }}>

    <div className="editor-shell">

      <header className="editor-header">

        <div className="editor-heading">

          <h2 id="editor-title">수동 편집기</h2>

          <p id="filename">파일명: {image.filename}{imageIndex >= 0 && <span className="image-position"> ({imageIndex + 1}/{imageCount})</span>}</p>

        </div>

        <div className="editor-actions">

          <button id="pose-button" type="button" disabled={disabled} onClick={() => void estimate()}>{busy === 'pose' ? '분석 중…' : '자동 라벨링'}</button>

          <button id="save-labels" type="button" disabled={disabled || ((hasSavedTxt || labelLoadFailed) && !dirty)} onClick={() => void save()}>

            {busy === 'save' ? '저장 중…' : dirty ? '저장 *' : '저장'}

          </button>

          <button id="reload-labels" type="button" disabled={disabled} onClick={() => void reload()}>다시 불러오기</button>

          <button id="download-labels" type="button" disabled={disabled} onClick={() => void download()}>.json 다운로드</button>

          <button id="editor-close" type="button" aria-label="편집기 닫기" autoFocus onClick={requestClose}>닫기</button>

        </div>

      </header>

      <div className="editor-body">

        <section className="preview" aria-label="이미지 미리보기">

          {!ready && <p id="empty-message">{status.error ? '불러오지 못했습니다. 창을 닫고 다시 선택하세요.' : '이미지와 라벨을 불러오고 있습니다.'}</p>}

          <div className="preview-surface" hidden={!ready} style={{

            '--image-ratio': imageSize.width / imageSize.height,

            '--image-width': `${imageSize.width}px`,

          } as CSSProperties}>

            <canvas ref={canvasRef} id="preview-canvas" aria-label="선택한 이미지와 관절" tabIndex={0} hidden={!ready} />

            {Math.abs(snapshot.zoom - 1) > 0.005 && <span id="zoom-level" className="zoom-badge" aria-live="polite">

              {Math.round(snapshot.zoom * 100)}%

            </span>}

          </div>

        </section>

        <EditorTools editor={editorRef.current} snapshot={snapshot} disabled={disabled} />

      </div>

      <p id="editor-status" className={`editor-status${status.error ? ' error' : ''}`} role="status" aria-live="polite">{status.message}</p>

    </div>

  </dialog>;

}

