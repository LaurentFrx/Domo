FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY airpods_ble.py .

CMD ["python", "-u", "airpods_ble.py"]
