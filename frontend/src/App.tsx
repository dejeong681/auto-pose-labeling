import { useEffect, useRef, useState, type FormEvent } from 'react';
import { listImages, uploadImage } from './api';
import EditorModal from './components/EditorModal';
import ImageList from './components/ImageList';
import type { ImageInfo } from './types';

export default function App() {
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [selectedImage, setSelectedImage] = useState<ImageInfo | null>(null);
  const [activeFilename, setActiveFilename] = useState('');
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState({ message: '저장된 이미지를 불러오고 있습니다.', error: false });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    listImages(controller.signal).then((items) => {
      setImages(items);
      setStatus({ message: items.length ? `저장된 이미지 ${items.length}장` : '첫 이미지를 업로드하세요.', error: false });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setStatus({ message: error.message, error: true });
    });
    return () => controller.abort();
  }, []);

  function openImage(image: ImageInfo) {
    setActiveFilename(image.filename);
    setSelectedImage(image);
  }

  const selectedIndex = images.findIndex((image) => image.filename === selectedImage?.filename);
  function navigateImage(direction: -1 | 1) {
    const next = selectedIndex + direction;
    if (selectedIndex >= 0 && next >= 0 && next < images.length) openImage(images[next]);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setStatus({ message: '이미지를 업로드하고 있습니다.', error: false });
    try {
      const image = await uploadImage(file);
      setImages(await listImages());
      openImage(image);
      if (fileInput.current) fileInput.current.value = '';
      // 같은 이름은 서버에서 건너뜁니다. 중복 안내는 표시하지 않습니다.
      setStatus({ message: '', error: false });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : '업로드에 실패했습니다.', error: true });
    } finally { setUploading(false); }
  }

  return <>
    <main>
      <h1>Auto Pose Labeling</h1>
      <p className="description">이미지를 선택하고 자동 라벨링으로 관절을 확인하세요.</p>
      <form id="upload-form" onSubmit={upload}>
        <label htmlFor="image-file">이미지 선택</label>
        <input ref={fileInput} id="image-file" name="file" type="file" accept=".jpg,.jpeg,.png,.webp,.bmp" required disabled={uploading} />
        <button id="upload-button" type="submit" disabled={uploading}>업로드</button>
        <span>한 장당 10MB까지</span>
        {/* 기존 버튼은 남겨 두며, 아직 없는 일괄 실행 기능은 연결하지 않습니다. */}
        <button type="button" disabled>전체 자동라벨링</button>
      </form>
      <p id="status" role="status" aria-live="polite" className={status.error ? 'error' : ''}>{status.message}</p>
      <ImageList images={images} activeFilename={activeFilename} onSelect={openImage} />
    </main>
    {selectedImage && <EditorModal key={selectedImage.filename} image={selectedImage}
      imageIndex={selectedIndex} imageCount={images.length} onNavigate={navigateImage}
      onClose={() => setSelectedImage(null)} />}
  </>;
}
