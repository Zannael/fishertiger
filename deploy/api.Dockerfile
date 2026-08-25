FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY advisor/ ./advisor/

RUN mkdir -p config/profiles data/raw data/processed data/uploads

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/profiles', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "advisor.server", "--host", "0.0.0.0", "--port", "8000"]
