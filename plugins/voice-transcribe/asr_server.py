# -*- coding: utf-8 -*-
"""
本地语音识别服务（faster-whisper）。

为什么要有这么一个常驻服务，而不是每条语音起一次 python：
  whisper 模型加载要好几秒，一条几秒的语音如果每次都重新加载，
  光加载就比识别本身久得多。常驻之后模型只在第一次请求时加载一次。

接口（只监听 127.0.0.1，不对外）：
  GET  /health       → {"ok": true, "model": "...", "loaded": true/false}
  POST /transcribe   → 请求体是音频文件原始字节（wav / amr / silk 都行，
                       由 PyAV 解码），返回 {"ok": true, "text": "...", "lang": "zh"}
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 模型走国内镜像下载：直连 huggingface.co 在这台机器上是不通的
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# 新版 huggingface_hub 默认走 xet 加速，而镜像站不支持 xet，
# 会以 401 失败（cas-server.xethub.hf.co）。必须关掉，退回普通 HTTP 下载。
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HERE = os.path.dirname(os.path.abspath(__file__))
# 模型不放插件目录里：QQ-agent 用 fs.watch 递归监听 plugins/，模型文件一落盘
# 就会被当成"插件代码变了"反复重载，把识别服务杀来杀去。放到 data/ 下就清静了。
APP_ROOT = os.path.dirname(os.path.dirname(HERE))
MODEL_DIR = os.environ.get("ASR_MODEL_DIR") or os.path.join(APP_ROOT, "data", "asr-models")
MODEL_SIZE = os.environ.get("ASR_MODEL", "small")
PORT = int(os.environ.get("ASR_PORT", "18791"))
# 中文群里偶尔夹英文，强制 zh 比自动检测稳；纯英文句子里英文词照样认得出
LANGUAGE = os.environ.get("ASR_LANG", "zh") or None

_model = None
_model_lock = threading.Lock()   # 加载互斥
_infer_lock = threading.Lock()   # 推理串行（CPU 上并发只会互相拖慢）


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel
                t0 = time.time()
                _model = WhisperModel(
                    MODEL_SIZE,
                    device="cpu",
                    compute_type="int8",
                    download_root=MODEL_DIR,
                    local_files_only=False,
                )
                print(f"[asr] 模型 {MODEL_SIZE} 加载完成，用时 {time.time() - t0:.1f}s", flush=True)
    return _model


def transcribe(audio_bytes):
    model = get_model()
    with _infer_lock:
        segments, info = model.transcribe(
            io.BytesIO(audio_bytes),
            language=LANGUAGE,
            # whisper 默认常吐繁体；给一句简体中文当引子，输出就会跟着用简体
            initial_prompt="以下是普通话的句子，请用简体中文。",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=1,
            condition_on_previous_text=False,
            # 短语音不需要上下文延续，关掉能避免上一句带偏下一句
        )
        text = "".join(s.text for s in segments).strip()
    return text, getattr(info, "language", "") or ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 不刷屏，要排查就看插件那边的日志

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            return self._send(200, {"ok": True, "model": MODEL_SIZE, "loaded": _model is not None, "port": PORT})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/transcribe":
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return self._send(400, {"ok": False, "error": "空请求体"})
            if n > 30 * 1024 * 1024:
                return self._send(413, {"ok": False, "error": "音频太大"})
            audio = b""
            while len(audio) < n:
                chunk = self.rfile.read(min(65536, n - len(audio)))
                if not chunk:
                    break
                audio += chunk
            t0 = time.time()
            text, lang = transcribe(audio)
            return self._send(200, {
                "ok": True,
                "text": text,
                "lang": lang,
                "ms": int((time.time() - t0) * 1000),
            })
        except Exception as e:  # 任何异常都要回结构化结果，别让 node 端一直等
            import traceback
            traceback.print_exc()
            return self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    if not os.path.isdir(MODEL_DIR):
        os.makedirs(MODEL_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"[asr] listening on 127.0.0.1:{PORT} model={MODEL_SIZE} dir={MODEL_DIR}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
