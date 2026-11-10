
"""이미지 업로드 → 포즈 자동 라벨링 → 수동 편집 → TXT 저장/JSON 다운로드.


설치: python -m pip install -r requirements.txt
실행: python -m uvicorn app:app --reload
접속: http://127.0.0.1:8000
"""

from collections import Counter
from functools import lru_cache
from io import BytesIO
import logging
from math import isfinite
from pathlib import Path, PureWindowsPath
from threading import Lock
from tempfile import NamedTemporaryFile, mkdtemp
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ValidationError

from pose_labels import PoseLabels, bbox_labels_from_txt, from_yolo_txt, normalized_labels, to_bbox_txt, to_yolo_txt

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
IMAGE_DIR = BASE_DIR / "data" / "images"

LABEL_DIR = BASE_DIR / "data" / "labels"
BBOX_LABEL_DIR = BASE_DIR / "data" / "bbox_labels"

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 한 장당 10MB
IMAGE_FORMATS = {"JPEG": (".jpg", ".jpeg"), "PNG": (".png",), "WEBP": (".webp",), "BMP": (".bmp",)}
IMAGE_EXTENSIONS = {suffix for suffixes in IMAGE_FORMATS.values() for suffix in suffixes}
MODEL_PATH = BASE_DIR / "models" / "yolo11n-pose.pt"
DET_CONF = 0.25
KP_CONF = 0.5  # 관절 표시 기준인 임시값입니다. 실제 결과로 조정하세요.
IMGSZ = 640
DEVICE = "cpu"
POSE_EDGES = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11),
              (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
              (0, 1), (0, 2), (1, 3), (2, 4)]
POSE_LOCK = Lock()  # 한 모델에 여러 추론 요청이 동시에 들어가지 않도록 합니다.
LABEL_SAVE_LOCK = Lock()  # 이미지와 라벨을 저장하거나 삭제하는 요청을 순서대로 처리합니다.

IMAGE_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Auto Pose Labeling")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/images", StaticFiles(directory=IMAGE_DIR), name="images")


def image_info(path: Path) -> dict:
    """브라우저에 전달할 파일 이름과 이미지 주소입니다."""
    # 파일 이름은 그대로 두고, 주소에서만 한글·공백·#·% 등을 인코딩합니다.
    return {"filename": path.name, "url": f"/images/{quote(path.name, safe='')}"}


def validate_filename(filename: str | None) -> str:
    """이름을 바꾸지 않고 검사합니다. 경로가 포함되면 저장하지 않습니다."""
    if not filename or any(c in '<>:"/\\|?*' or ord(c) < 32 or ord(c) == 127 for c in filename):
        raise HTTPException(400, "파일명에 경로나 사용할 수 없는 문자가 포함되어 있습니다.")
    if filename.endswith((".", " ")) or PureWindowsPath(filename).is_reserved():
        raise HTTPException(400, "저장할 수 없는 파일명입니다. 파일 이름을 확인하세요.")
    if Path(filename).suffix.lower() not in IMAGE_EXTENSIONS:
        raise HTTPException(400, "JPG, JPEG, PNG, WEBP, BMP 이미지만 지원합니다.")
    return filename


@app.get("/")
def home():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/images")
def list_images():
    """새로고침 후에도 서버에 저장된 이미지를 다시 불러옵니다."""
    with LABEL_SAVE_LOCK:
        paths = stored_images()
        paths.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
        stem_counts = Counter(path.stem.casefold() for path in paths)
        items = []
        for path in paths:
            shared_stem = stem_counts[path.stem.casefold()] > 1
            items.append({**image_info(path), **image_label_summary(path, shared_stem)})
        return items


def stored_images() -> list[Path]:
    return [path for path in IMAGE_DIR.iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS and path.is_file()]


def read_legacy_labels(path: Path, filename: str) -> PoseLabels:
    document = json.loads(path.read_text(encoding="utf-8"))
    if document["filename"] != filename or document["schema_version"] != 1:
        raise ValueError("이미지 또는 라벨 형식이 다릅니다.")
    return PoseLabels.model_validate(document)


def read_saved_labels(path: Path, filename: str) -> tuple[PoseLabels | None, bool]:
    """저장된 라벨과 이전 JSON인지 여부를 반환합니다."""
    if path.is_file():
        return from_yolo_txt(path.read_text(encoding="utf-8-sig")), False
    legacy_path = LABEL_DIR / (filename + ".json")
    if legacy_path.is_file():
        return read_legacy_labels(legacy_path, filename), True
    return None, False


def image_label_summary(image: Path, shared_stem: bool) -> dict:
    try:
        filename = validate_filename(image.name)
        path = label_path_for(filename) if shared_stem else LABEL_DIR / (image.stem + ".txt")
        labels, _ = read_saved_labels(path, filename)
    except (HTTPException, OSError, ValueError, KeyError, TypeError, ValidationError):
        # 편집기가 사람을 불러오지 못해도 박스 TXT의 클래스는 목록 필터에 사용할 수 있습니다.
        class_ids = image_class_ids(image, shared_stem)
        return {"class_ids": class_ids or [], "has_labels": class_ids is not None, "person_count": 0}
    people = labels.people if labels is not None else []
    return {
        "class_ids": sorted({person.class_id for person in people}),
        "has_labels": labels is not None,
        "person_count": len(people),
    }


def image_class_ids(image: Path, shared_stem: bool) -> list[int] | None:
    """클래스 번호를 읽습니다. 빈 라벨은 [], 읽을 수 있는 라벨이 없으면 None입니다."""
    txt = LABEL_DIR / (image.stem + ".txt")
    legacy = LABEL_DIR / (image.name + ".json")
    try:
        if txt.is_file():
            if shared_stem:
                return None
            classes = set()
            for line in txt.read_text(encoding="utf-8-sig").splitlines():
                fields = line.split()
                if not fields:
                    continue
                if len(fields) not in (5, 56) or int(fields[0]) < 0:
                    return None
                classes.add(int(fields[0]))
            return sorted(classes)
        if legacy.is_file():
            return sorted({person.class_id for person in read_legacy_labels(legacy, image.name).people})
    except (OSError, ValueError, KeyError, TypeError):
        # 한 라벨이 잘못되어도 나머지 이미지의 목록을 열 수 있습니다.
        return None
    return None


@app.post("/api/images", status_code=201)
async def upload_image(file: UploadFile):
    """브라우저가 보낸 파일을 검사한 뒤 원본 바이트를 저장합니다."""
    try:
        filename = validate_filename(file.filename)
        path = IMAGE_DIR / filename
        if path.is_file():
            return JSONResponse({**image_info(path), "skipped": True}, status_code=200)
        content = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if not content:
        raise HTTPException(400, "빈 파일은 업로드할 수 없습니다.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "이미지는 한 장당 10MB까지 업로드할 수 있습니다.")

    # 확장자만 확인하지 않고 실제 이미지 형식을 읽습니다.
    try:
        with Image.open(BytesIO(content)) as image:
            image_format = image.format
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
        raise HTTPException(400, "이미지 파일을 확인하세요.")
    if image_format not in IMAGE_FORMATS:
        raise HTTPException(400, "JPG, PNG, WEBP, BMP 이미지만 지원합니다.")

    if path.suffix.lower() not in IMAGE_FORMATS[image_format]:
        raise HTTPException(400, "파일 확장자와 실제 이미지 형식이 다릅니다. 원본 파일을 확인하세요.")
    with LABEL_SAVE_LOCK:
        try:
            # xb: 원래 이름으로 새 파일만 생성합니다. 이미 있으면 덮어쓰지 않습니다.
            with path.open("xb") as output:
                output.write(content)
        except FileExistsError:
            # 검사 뒤 다른 요청이 먼저 저장했더라도 기존 파일을 유지합니다.
            return JSONResponse({**image_info(path), "skipped": True}, status_code=200)
    return image_info(path)


@lru_cache(maxsize=1)
def load_pose_model(model_path: str):
    """첫 추론 때만 모델을 읽고 재사용합니다. 모델 교체 후에는 서버를 재시작하세요."""
    if not Path(model_path).is_file():
        raise HTTPException(404, "모델 파일이 없습니다.")
    try:
        from ultralytics import YOLO
    except ImportError:
        raise HTTPException(503, "포즈 추론 패키지를 설치하세요. requirements.txt를 확인하세요.")
    model = YOLO(model_path)
    if model.task != "pose":
        raise HTTPException(400, "COCO 17관절 포즈 모델을 지정하세요.")
    return model


def pose_response(filename: str, result) -> dict:
    """YOLO 결과를 브라우저에서 그릴 수 있는 정규화 좌표로 변환합니다."""
    height, width = result.orig_shape
    people = []
    if result.keypoints is not None and len(result.keypoints):
        points = result.keypoints.xyn.cpu().tolist()
        scores = result.keypoints.conf.cpu().tolist()
        boxes = result.boxes.xywhn.cpu().tolist()
        box_scores = result.boxes.conf.cpu().tolist()
        if not (len(points) == len(scores) == len(boxes) == len(box_scores)):
            raise HTTPException(500, "모델의 박스와 관절 개수가 일치하지 않습니다.")
        for box, box_score, person_points, person_scores in zip(boxes, box_scores, points, scores):
            if len(person_points) != 17 or len(person_scores) != 17:
                raise HTTPException(400, "COCO 17관절 포즈 모델을 지정하세요.")
            if len(box) != 4 or not all(isfinite(v) for v in [*box, box_score]):
                raise HTTPException(500, "모델의 박스 좌표를 확인하세요.")
            keypoints = []
            for (x, y), score in zip(person_points, person_scores):
                valid = all(isfinite(v) for v in (x, y, score)) and 0 <= x <= 1 and 0 <= y <= 1
                # usable은 화면 표시 여부입니다. 사람이 확인한 보임/가림 라벨(v)과는 다릅니다.
                usable = valid and score >= KP_CONF and (x != 0 or y != 0)
                keypoints.append({"x": x if valid else 0, "y": y if valid else 0,
                                  "confidence": score if valid else 0, "usable": bool(usable)})
            people.append({"box": box, "confidence": box_score, "keypoints": keypoints})
    return {"filename": filename, "width": width, "height": height,
            "people": people, "skeleton": POSE_EDGES}


@app.post("/api/images/{filename}/pose")
def estimate_pose(filename: str):
    """선택한 한 장만 추론합니다. def 함수이므로 FastAPI의 작업 스레드에서 실행됩니다."""
    path = IMAGE_DIR / validate_filename(filename)
    if not path.is_file():
        raise HTTPException(404, "이미지 파일이 없습니다.")
    # YOLO를 호출하기 전에 검사해 자동 다운로드 경로로 들어가지 않게 합니다.
    if not MODEL_PATH.is_file():
        raise HTTPException(404, "모델 파일이 없습니다.")
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        with POSE_LOCK:
            model = load_pose_model(str(MODEL_PATH.resolve()))
            result = model.predict(source=image, conf=DET_CONF, imgsz=IMGSZ,
                                   device=DEVICE, save=False, verbose=False)[0]
            return pose_response(filename, result)
    except HTTPException:
        raise
    except Exception:
        logging.exception("포즈 추론 실패: %s", filename)
        raise HTTPException(500, "포즈 추론에 실패했습니다. 서버 터미널을 확인하세요.")



def label_path_for(filename: str) -> Path:
    """YOLO 학습 형식에 맞춰 사진.jpg의 라벨을 사진.txt로 저장합니다."""
    filename = validate_filename(filename)
    if not (IMAGE_DIR / filename).is_file():
        raise HTTPException(404, "이미지 파일이 없습니다.")
    stem = Path(filename).stem
    # 확장자만 다른 같은 이름의 이미지가 한 TXT를 공유하지 않게 막습니다.
    for suffix in IMAGE_EXTENSIONS:
        other = IMAGE_DIR / (stem + suffix)
        if other.name.casefold() != filename.casefold() and other.is_file():
            raise HTTPException(409, "확장자만 다른 같은 이름의 이미지가 있어 TXT 라벨을 구분할 수 없습니다. 이미지 이름을 구분해 주세요.")
    return LABEL_DIR / (stem + ".txt")


@app.get("/api/images/{filename}/labels")
def get_labels(filename: str):
    path = label_path_for(filename)
    try:
        labels, needs_save = read_saved_labels(path, filename)
        if labels is None:
            return {"filename": filename, "exists": False, "needs_save": False, "people": []}
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        raise HTTPException(500, "저장된 라벨을 읽지 못했습니다. 라벨 파일을 확인하세요.")
    return {"filename": filename, "exists": True, "needs_save": needs_save, **normalized_labels(labels)}


@app.put("/api/images/{filename}/labels")
def save_labels(filename: str, labels: PoseLabels, overwrite: bool = True):
    data = normalized_labels(labels)
    text = to_yolo_txt(labels)
    with LABEL_SAVE_LOCK:
        path = label_path_for(filename)
        # 일괄 작업 중 다른 화면에서 먼저 저장했더라도 기존 TXT·JSON을 보존합니다.
        legacy_path = LABEL_DIR / (filename + ".json")
        if not overwrite and (path.exists() or legacy_path.exists()):
            return {**get_labels(filename), "skipped": True}
        try:
            write_label_txt(path, text)
        except OSError:
            logging.exception("라벨 저장 실패: %s", filename)
            raise HTTPException(500, "라벨을 저장하지 못했습니다.")
    return {"filename": filename, "exists": True, "needs_save": False, **data}


def write_label_txt(path: Path, text: str) -> None:
    """임시 파일에 다 쓴 뒤 교체해 저장 중 기존 TXT가 잘리지 않게 합니다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(text)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class ImageSelectionRequest(BaseModel):
    filenames: list[str]


@app.post("/api/images/labels/bbox/save")
def save_bbox_labels(request: ImageSelectionRequest):
    filenames = list(dict.fromkeys(validate_filename(name) for name in request.filenames))
    saved = []
    skipped = []
    failed = []
    with LABEL_SAVE_LOCK:
        stem_counts = Counter(path.stem.casefold() for path in stored_images())
        for filename in filenames:
            if stem_counts[Path(filename).stem.casefold()] > 1:
                failed.append({"filename": filename, "message": "확장자를 빼면 이름이 같은 이미지가 있습니다. 파일 이름을 구분해 주세요."})
                continue
            try:
                source = label_path_for(filename)
                if source.is_file():
                    boxes = bbox_labels_from_txt(source.read_text(encoding="utf-8-sig"))
                else:
                    labels, _ = read_saved_labels(source, filename)
                    if labels is None:
                        skipped.append(filename)
                        continue
                    boxes = labels.people
                write_label_txt(BBOX_LABEL_DIR / source.name, to_bbox_txt(boxes))
            except HTTPException as error:
                failed.append({"filename": filename, "message": str(error.detail)})
            except (ValueError, KeyError, TypeError):
                failed.append({"filename": filename, "message": "저장된 라벨의 박스 좌표나 형식을 확인하세요."})
            except OSError:
                logging.exception("bbox 라벨 저장 실패: %s", filename)
                failed.append({"filename": filename, "message": "라벨 파일을 읽거나 저장하지 못했습니다."})
            else:
                saved.append(filename)
    return {"saved": saved, "skipped": skipped, "failed": failed}


def delete_image_files(paths: list[Path]) -> bool:
    """파일 이동이 모두 성공한 뒤 지웁니다. 이동 도중 실패하면 제자리로 되돌립니다."""
    pending = Path(mkdtemp(prefix=".deleting-", dir=IMAGE_DIR.parent))
    moved = []
    try:
        for path in paths:
            target = pending / path.name
            path.rename(target)
            moved.append((path, target))
    except OSError:
        for original, target in reversed(moved):
            try:
                target.rename(original)
            except OSError:
                logging.exception("삭제 중 파일 복원 실패: %s", target)
        if not any(pending.iterdir()):
            pending.rmdir()
        raise

    try:
        for _, target in moved:
            target.unlink()
        pending.rmdir()
        return True
    except OSError:
        logging.exception("삭제 임시 파일 정리 실패: %s", pending)
        return False


@app.post("/api/images/delete")
def delete_images(request: ImageSelectionRequest):
    return delete_selected_files(request, labels_only=False)


@app.post("/api/images/labels/delete")
def delete_labels(request: ImageSelectionRequest):
    return delete_selected_files(request, labels_only=True)


def delete_selected_files(request: ImageSelectionRequest, *, labels_only: bool):
    filenames = list(dict.fromkeys(validate_filename(name) for name in request.filenames))
    deleted = []
    failed = []
    cleanup_pending = []
    with LABEL_SAVE_LOCK:
        images = {path.name: path for path in stored_images()}
        stem_counts = Counter(path.stem.casefold() for path in images.values())
        for filename in filenames:
            image = images.get(filename)
            if image is None:
                # 이미 삭제된 파일을 다시 요청해도 목록을 정리할 수 있습니다.
                deleted.append(filename)
                continue
            txt = LABEL_DIR / (image.stem + ".txt")
            legacy = LABEL_DIR / (filename + ".json")
            if txt.exists() and stem_counts[image.stem.casefold()] > 1:
                failed.append({"filename": filename, "message": "같은 이름의 이미지가 TXT를 공유합니다. 파일 이름을 구분해 주세요."})
                continue
            try:
                paths = [txt, legacy]
                if not labels_only:
                    paths.append(image)
                existing_paths = [path for path in paths if path.is_file()]
                cleaned = not existing_paths or delete_image_files(existing_paths)
            except OSError:
                logging.exception("이미지 삭제 실패: %s", filename)
                failed.append({"filename": filename, "message": "파일을 삭제하지 못했습니다. 사용 중인 파일인지 확인하세요."})
                continue
            deleted.append(filename)
            if not cleaned:
                cleanup_pending.append(filename)
    return {"deleted": deleted, "failed": failed, "cleanup_pending": cleanup_pending}


@app.post("/api/images/{filename}/labels/export")
def export_labels(filename: str, labels: PoseLabels):
    filename = validate_filename(filename)
    if not (IMAGE_DIR / filename).is_file():
        raise HTTPException(404, "이미지 파일이 없습니다.")
    document = {"schema_version": 1, "filename": filename, **normalized_labels(labels)}
    download_name = quote(Path(filename).stem + ".json", safe="")
    return Response(json.dumps(document, ensure_ascii=False, allow_nan=False, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{download_name}"})

