FROM python:3.10-slim

WORKDIR /app

# OpenCV runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# HF Spaces route traffic to this port
EXPOSE 7860
# Cache model downloads inside the container
ENV HF_HOME=/app/.cache

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
