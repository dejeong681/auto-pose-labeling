"""수동 라벨을 검사하고 YOLO 17관절 TXT를 읽고 씁니다."""

from math import isfinite

from pydantic import BaseModel, Field, field_validator


class JointLabel(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    v: int = Field(ge=0, le=2, strict=True)


class PersonLabel(BaseModel):
    class_id: int = Field(ge=0, strict=True)
    box: list[float] = Field(min_length=4, max_length=4)
    keypoints: list[JointLabel] = Field(min_length=17, max_length=17)

    @field_validator("box")
    @classmethod
    def validate_box(cls, values):
        cx, cy, width, height = values
        if not all(isfinite(v) for v in values) or not (0 < width <= 1 and 0 < height <= 1):
            raise ValueError("박스 크기와 좌표를 확인하세요.")
        if min(cx - width / 2, cy - height / 2) < -1e-6 or max(cx + width / 2, cy + height / 2) > 1 + 1e-6:
            raise ValueError("박스가 이미지 범위를 벗어났습니다.")
        return values


class PoseLabels(BaseModel):
    people: list[PersonLabel] = Field(max_length=1000)


def normalized_labels(labels: PoseLabels) -> dict:
    """v=0은 좌표도 0으로 저장하여 로컬 편집기와 같은 의미로 맞춥니다."""
    data = labels.model_dump()
    for person in data["people"]:
        for point in person["keypoints"]:
            if point["v"] == 0:
                point["x"] = point["y"] = 0
    return data


def to_yolo_txt(labels: PoseLabels) -> str:
    lines = []
    for person in normalized_labels(labels)["people"]:
        fields = [str(person["class_id"])] + [f"{v:.8f}" for v in person["box"]]
        for point in person["keypoints"]:
            if point["v"]:
                fields.extend([f"{point['x']:.8f}", f"{point['y']:.8f}", str(point["v"])])
            else:
                fields.extend(["0", "0", "0"])
        lines.append(" ".join(fields))
    return "\n".join(lines) + ("\n" if lines else "")


def from_yolo_txt(text: str) -> PoseLabels:
    """한 줄의 56개 값을 클래스·박스 4개·관절 17개로 나눠 검증합니다."""
    people = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        fields = line.split()
        if not fields:  # 빈 파일은 사람이 없는 라벨이며, 중간 빈 줄도 건너뜁니다.
            continue
        if len(fields) != 56:
            raise ValueError(f"{line_number}번째 줄은 17관절 기준 56개 값이어야 합니다.")
        people.append({
            "class_id": int(fields[0]),
            "box": [float(value) for value in fields[1:5]],
            "keypoints": [
                {"x": float(fields[index]), "y": float(fields[index + 1]), "v": int(fields[index + 2])}
                for index in range(5, 56, 3)
            ],
        })
    # 기존 검사기를 재사용해 좌표 범위·클래스·관절 상태도 확인합니다.
    return PoseLabels.model_validate({"people": people})
