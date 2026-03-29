FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git git-lfs cmake build-essential patchelf \
  && git lfs install \
  && rm -rf /var/lib/apt/lists/*

# Build libmoonshine.so from source and install it system-wide
RUN git clone --depth=1 https://github.com/moonshine-ai/moonshine.git /tmp/moonshine \
  && mkdir -p /tmp/moonshine/core/build \
  && cd /tmp/moonshine/core/build \
  && cmake .. \
  && cmake --build . --config Release \
  && cp /tmp/moonshine/core/build/libmoonshine.so /usr/local/lib/ \
  && ARCH=$(uname -m) \
  && cp /tmp/moonshine/core/third-party/onnxruntime/lib/linux/${ARCH}/libonnxruntime.so.1 /usr/local/lib/ \
  && ln -s /usr/local/lib/libonnxruntime.so.1 /usr/local/lib/libonnxruntime.so \
  && ldconfig \
  && rm -rf /tmp/moonshine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Moonshine base model weights at build time
RUN python -c "from moonshine_voice import get_model_for_language; get_model_for_language('en')"

COPY server.py .

EXPOSE 8765

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8765"]
