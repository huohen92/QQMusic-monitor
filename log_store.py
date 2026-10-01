"""运行日志缓冲区

把 print() 与 uvicorn/第三方库写到 stdout/stderr 的内容收进内存环形缓冲，
供网页「日志」页查看（/api/logs）。

实现方式：在 main.py 最早期调用 install()，用 Tee 把 sys.stdout / sys.stderr
替换成"既写原始终端、又按行收进缓冲"的流。这样不需要改动任何 print 语句，
uvicorn 自己的日志（写 sys.stdout/sys.stderr）也会一并被捕获。
"""

import collections
import sys
import threading
import time

# 最多保留多少条日志（环形缓冲，超出丢弃最旧的）
MAX_RECORDS = 3000

_records = collections.deque(maxlen=MAX_RECORDS)
_lock = threading.Lock()
_seq = 0
_installed = False

_orig_stdout = sys.stdout
_orig_stderr = sys.stderr


def _add(message: str, level: str = "INFO", source: str = "app") -> None:
    """向缓冲追加一条日志"""
    global _seq
    message = (message or "").rstrip("\n")
    if not message.strip():
        return
    with _lock:
        _seq += 1
        _records.append({
            "seq": _seq,
            "ts": time.time(),
            "level": level,
            "source": source,
            "message": message,
        })


class _TeeStream:
    """把写入转发给原始终端，同时按行收进缓冲"""

    def __init__(self, stream, level: str, source: str):
        self._stream = stream
        self._level = level
        self._source = source
        self._buf = ""
        self._buf_lock = threading.Lock()

    def write(self, data):
        if not data:
            return 0
        try:
            self._stream.write(data)
        except Exception:
            pass
        with self._buf_lock:
            self._buf += data
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                _add(line, self._level, self._source)
        return len(data)

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass
        with self._buf_lock:
            if self._buf:
                _add(self._buf, self._level, self._source)
                self._buf = ""

    # 兼容 uvicorn / logging 对流属性的探测（isatty、encoding、fileno 等）
    def __getattr__(self, name):
        return getattr(self._stream, name)


def install() -> None:
    """接管 stdout/stderr（幂等）"""
    global _installed
    if _installed:
        return
    _installed = True
    sys.stdout = _TeeStream(_orig_stdout, "INFO", "stdout")
    sys.stderr = _TeeStream(_orig_stderr, "ERROR", "stderr")
    _add("日志采集已启动", "INFO", "log_store")


def get_logs(after: int = 0, limit: int = 500) -> dict:
    """获取日志

    Args:
        after: 只返回 seq 大于该值的日志（用于前端增量轮询）
        limit: 最多返回多少条（取尾部）
    """
    with _lock:
        if after and after > 0:
            items = [r for r in _records if r["seq"] > after]
        else:
            items = list(_records)
        if limit and limit > 0:
            items = items[-limit:]
        return {
            "logs": items,
            "last_seq": _records[-1]["seq"] if _records else 0,
            "first_seq": _records[0]["seq"] if _records else 0,
            "kept": len(_records),
            "max_records": MAX_RECORDS,
        }


def clear() -> int:
    """清空缓冲，返回清掉的条数"""
    with _lock:
        count = len(_records)
        _records.clear()
    return count
