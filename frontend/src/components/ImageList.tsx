import type { ImageInfo } from '../types';

type Props = { images: ImageInfo[]; activeFilename: string; onSelect: (image: ImageInfo) => void };

export default function ImageList({ images, activeFilename, onSelect }: Props) {
  return <section className="image-library" aria-labelledby="image-list-title">
    <h2 id="image-list-title">업로드된 이미지</h2>
    <div id="image-list">
      {images.length ? images.map((image) => <button
        key={image.filename} type="button" data-filename={image.filename}
        className={`image-button${image.filename === activeFilename ? ' active' : ''}`}
        onClick={() => onSelect(image)}
      >
        <img className="image-thumbnail" src={image.url} alt="" loading="lazy" />
        <span>{image.filename}</span>
      </button>) : '저장된 이미지가 없습니다.'}
    </div>
  </section>;
}
