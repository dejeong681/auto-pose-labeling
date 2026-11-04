# 1. React 화면을 빌드하는 단계
FROM node:24-bookworm-slim AS frontend_build

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# 2. Python으로 웹사이트를 실행할 환경
FROM python:3.11-slim-bookworm

WORKDIR /app

# 서버 로그를 바로 출력
ENV PYTHONUNBUFFERED=1

# OpenCV 실행에 필요한 Linux 라이브러리 설치
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# CPU용 PyTorch 설치
RUN python -m pip install --no-cache-dir \
    torch==2.13.0 torchvision==0.28.0 \
    --index-url https://download.pytorch.org/whl/cpu

# 프로젝트의 Python 패키지 설치
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

# Python 코드와 빌드된 화면 복사
COPY app.py pose_labels.py ./
COPY --from=frontend_build /build/frontend/dist ./frontend/dist

EXPOSE 8000

# 컨테이너를 실행했을 때 시작할 프로그램
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]