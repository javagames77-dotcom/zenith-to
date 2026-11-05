# zenit-cutout — белый фон для фото

Удаляет фон (rembg + ISNet, бесплатно), ставит деталь на белый квадрат 1600×1600.

- `GET /health` — проверка
- `POST /cutout` — JSON `{"url": "<ссылка на фото>"}` → JPEG на белом фоне

Переменные (необязательно): `CUTOUT_TOKEN` — если задан, нужен заголовок `X-Token`;
`CUTOUT_THREADS` (2), `CUTOUT_MAX_SIDE` (2000).

Railway: Deploy from GitHub → Root Directory `cutout` → Dockerfile собирается сам →
Networking → Generate Domain (порт 8000). Память ~0,9 ГБ, ~5 с на фото.
