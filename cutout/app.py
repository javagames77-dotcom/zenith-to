"""
Зеніт-Авто.фото — сервис «каталожной» версии фото.
Удаляет фон (rembg + ISNet), ставит деталь на белый квадрат.
POST /cutout  JSON: {"url": "..."} или {"image_base64": "..."}
              необязательно: size (1600), fill (0.85), quality (92)
Ответ: image/jpeg.
Если задана переменная CUTOUT_TOKEN, нужен заголовок X-Token.
"""
import base64, io, os
import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from PIL import Image, ImageOps
import onnxruntime as ort
from rembg import remove, new_session

MODEL = os.getenv("CUTOUT_MODEL", "isnet-general-use")
TOKEN = os.getenv("CUTOUT_TOKEN", "")
MAX_SIDE = int(os.getenv("CUTOUT_MAX_SIDE", "2000"))   # обрабатываем не больше 2000 px

# Экономим память: без «арены» onnxruntime процесс не раздувается до 2 ГБ
_opts = ort.SessionOptions()
_opts.enable_cpu_mem_arena = False
_opts.enable_mem_pattern = False
_opts.intra_op_num_threads = int(os.getenv("CUTOUT_THREADS", "2"))
_opts.inter_op_num_threads = 1
session = new_session(MODEL, sess_opts=_opts)
app = FastAPI(title="zenit-cutout")


class Req(BaseModel):
    url: str | None = None
    image_base64: str | None = None
    size: int = 1600
    fill: float = 0.85
    quality: int = 92


def load_image(r: Req) -> Image.Image:
    if r.image_base64:
        data = base64.b64decode(r.image_base64)
    elif r.url:
        try:
            resp = requests.get(r.url, timeout=60)
        except requests.RequestException as e:
            raise HTTPException(400, f"Не удалось скачать фото: {e.__class__.__name__}")
        if resp.status_code != 200:
            raise HTTPException(400, f"Не удалось скачать фото: {resp.status_code}")
        data = resp.content
    else:
        raise HTTPException(400, "Нужен url или image_base64")
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    return im


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/cutout")
def cutout(r: Req, x_token: str | None = Header(default=None)):
    if TOKEN and x_token != TOKEN:
        raise HTTPException(401, "Неверный токен")
    im = load_image(r)
    cut = remove(im, session=session, post_process_mask=True)
    bbox = cut.getbbox()
    if not bbox:
        raise HTTPException(422, "Деталь на фото не найдена")
    obj = cut.crop(bbox)
    size = max(400, min(r.size, 4000))
    fill = max(0.5, min(r.fill, 0.98))
    k = fill * size / max(obj.size)
    obj = obj.resize((max(1, round(obj.width * k)), max(1, round(obj.height * k))), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    canvas.paste(obj, ((size - obj.width) // 2, (size - obj.height) // 2), obj)
    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=max(60, min(r.quality, 98)), optimize=True)
    return Response(buf.getvalue(), media_type="image/jpeg")
