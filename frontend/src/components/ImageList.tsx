import type { ImageInfo } from '../types';

type Props = {
  images: ImageInfo[];
  activeFilename: string;
  onSelect: (image: ImageInfo) => void;
  checkedImages: ReadonlySet<string>;
  onCheck: (filename: string, checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  emptyMessage?: string;
};

export default function ImageList({ images, activeFilename, onSelect, checkedImages, onCheck, disabled = false,
  title = '업로드된 이미지', emptyMessage = '저장된 이미지가 없습니다.' }: Props) {
  return <section className="image-library" aria-labelledby="image-list-title">
    <h2 id="image-list-title">{title}</h2>
    <div id="image-list">
      {images.length ? images.map((image) => <div className="image-card" key={image.filename}>
        <input type="checkbox" className="image-check" aria-label={`${image.filename} 삭제 대상으로 선택`}
          checked={checkedImages.has(image.filename)} disabled={disabled}
          onChange={(event) => onCheck(image.filename, event.target.checked)} />
        <button type="button" data-filename={image.filename} disabled={disabled}
          className={`image-button${image.filename === activeFilename ? ' active' : ''}`}
          onClick={() => onSelect(image)}>
          <img className="image-thumbnail" src={image.url} alt="" loading="lazy" />
          <span>{image.filename}</span>
        </button>
      </div>) : emptyMessage}
    </div>
  </section>;
}
